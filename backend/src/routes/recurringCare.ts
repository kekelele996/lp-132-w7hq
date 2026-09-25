import { Router, Response } from 'express';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { sendServerError } from '../utils/httpResponses';
import { AuthRequest, authenticate, requireRole } from '../middleware/auth';

const router = Router();

const SHIFT_WINDOWS: Record<string, { label: string; startHour: number; endHour: number; duration: number }> = {
  morning: { label: '早班', startHour: 8, endHour: 12, duration: 4 },
  afternoon: { label: '午班', startHour: 12, endHour: 18, duration: 6 },
  evening: { label: '晚班', startHour: 18, endHour: 22, duration: 4 },
  full: { label: '全天', startHour: 8, endHour: 18, duration: 10 },
};

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const pad = (value: number) => String(value).padStart(2, '0');

const formatDate = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const normalizeWeekday = (value: unknown): number | null => {
  const weekday = Number(value);
  if (!Number.isInteger(weekday)) {
    return null;
  }
  if (weekday === 7) {
    return 0;
  }
  return weekday >= 0 && weekday <= 6 ? weekday : null;
};

const buildOccurrences = (weekday: number, shiftType: string) => {
  const shift = SHIFT_WINDOWS[shiftType];
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  first.setDate(first.getDate() + ((weekday - first.getDay() + 7) % 7));

  const firstStart = new Date(first);
  firstStart.setHours(shift.startHour, 0, 0, 0);
  if (firstStart <= now) {
    first.setDate(first.getDate() + 7);
  }

  return Array.from({ length: 4 }, (_, index) => {
    const date = new Date(first);
    date.setDate(first.getDate() + index * 7);

    const startTime = new Date(date);
    startTime.setHours(shift.startHour, 0, 0, 0);
    const endTime = new Date(date);
    endTime.setHours(shift.endHour, 0, 0, 0);

    return {
      week: index + 1,
      date: formatDate(date),
      startTime,
      endTime,
    };
  });
};

const conflictResponse = (week: number, date: string) => ({
  message: `第${week}周（${date}）该护工此时段已有未结束订单，本次常护安排未保存`,
  conflict_week: week,
  conflict_date: date,
});

router.post('/', authenticate, requireRole('child'), async (req: AuthRequest, res: Response) => {
  const {
    elderly_id,
    worker_id,
    title,
    description,
    care_type,
    address,
    price,
  } = req.body;
  const weekday = normalizeWeekday(req.body.weekday ?? req.body.week_day ?? req.body.day_of_week);
  const shiftType = String(req.body.shift_type ?? req.body.time_slot ?? req.body.slot ?? '').trim().toLowerCase();

  if (!elderly_id || !worker_id || weekday === null || !SHIFT_WINDOWS[shiftType]) {
    return res.status(400).json({ message: '请选择老人、护工、每周星期和时段' });
  }

  const shift = SHIFT_WINDOWS[shiftType];
  const occurrences = buildOccurrences(weekday, shiftType);
  let client: PoolClient | undefined;
  let inTransaction = false;
  let attemptedWeek = 0;
  let attemptedDate = '';

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    inTransaction = true;

    const elderlyResult = await client.query(
      'SELECT id, name, address FROM elderly_profiles WHERE id = $1 AND child_id = $2',
      [elderly_id, req.user?.id]
    );

    if (elderlyResult.rows.length === 0) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return res.status(404).json({ message: '老人档案不存在或无权限' });
    }

    // 锁定护工，串行化同一护工的常护安排，避免并发提交同时通过冲突检查。
    const workerResult = await client.query(
      `SELECT id, real_name FROM users
       WHERE id = $1 AND role IN ('worker', 'volunteer')
       FOR UPDATE`,
      [worker_id]
    );

    if (workerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return res.status(404).json({ message: '护工不存在' });
    }

    const elderly = elderlyResult.rows[0];
    const finalTitle = title || `每周${WEEKDAY_LABELS[weekday]}${shift.label}常护`;
    const finalDescription = description || `常护安排：每周${WEEKDAY_LABELS[weekday]}${shift.label}上门服务`;
    const finalCareType = care_type || 'daily_care';
    const finalAddress = address || elderly.address;

    const planResult = await client.query(
      `INSERT INTO recurring_care_plans
       (child_id, elderly_id, worker_id, weekday, shift_type, title, description, care_type, address, duration_hours, price, start_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        req.user?.id,
        elderly_id,
        worker_id,
        weekday,
        shiftType,
        finalTitle,
        finalDescription,
        finalCareType,
        finalAddress,
        shift.duration,
        price ?? null,
        occurrences[0].date,
      ]
    );

    const plan = planResult.rows[0];
    const orders = [];

    for (const occurrence of occurrences) {
      attemptedWeek = occurrence.week;
      attemptedDate = occurrence.date;

      const conflictResult = await client.query(
        `SELECT cn.id
         FROM care_needs cn
         WHERE cn.worker_id = $1
           AND cn.status NOT IN ('completed', 'cancelled')
           AND cn.start_time < $3
           AND COALESCE(
                 cn.end_time,
                 cn.start_time + COALESCE(cn.duration_hours, 1) * INTERVAL '1 hour'
               ) > $2
         LIMIT 1`,
        [worker_id, occurrence.startTime, occurrence.endTime]
      );

      if (conflictResult.rows.length > 0) {
        await client.query('ROLLBACK');
        inTransaction = false;
        return res.status(409).json(conflictResponse(occurrence.week, occurrence.date));
      }

      const orderResult = await client.query(
        `INSERT INTO care_needs
         (child_id, elderly_id, title, description, care_type, start_time, end_time, address,
          duration_hours, price, status, worker_id, accepted_at, recurring_plan_id, recurrence_week, shift_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'accepted', $11, CURRENT_TIMESTAMP, $12, $13, $14)
         RETURNING *`,
        [
          req.user?.id,
          elderly_id,
          finalTitle,
          finalDescription,
          finalCareType,
          occurrence.startTime,
          occurrence.endTime,
          finalAddress,
          shift.duration,
          price ?? null,
          worker_id,
          plan.id,
          occurrence.week,
          shiftType,
        ]
      );

      const order = orderResult.rows[0];
      const scheduleResult = await client.query(
        `SELECT ws.id, ws.order_id, cn.status AS order_status
         FROM worker_schedules ws
         LEFT JOIN care_needs cn ON cn.id = ws.order_id
         WHERE ws.worker_id = $1 AND ws.date = $2 AND ws.shift_type = $3
         FOR UPDATE OF ws`,
        [worker_id, occurrence.date, shiftType]
      );

      const existingSchedule = scheduleResult.rows[0];
      const hasActiveScheduleOrder = existingSchedule?.order_id &&
        !['completed', 'cancelled'].includes(existingSchedule.order_status);

      if (hasActiveScheduleOrder) {
        await client.query('ROLLBACK');
        inTransaction = false;
        return res.status(409).json(conflictResponse(occurrence.week, occurrence.date));
      }

      if (existingSchedule) {
        await client.query(
          `UPDATE worker_schedules
           SET order_id = $1, recurring_plan_id = $2, is_available = FALSE
           WHERE id = $3`,
          [order.id, plan.id, existingSchedule.id]
        );
      } else {
        await client.query(
          `INSERT INTO worker_schedules
           (worker_id, date, shift_type, is_available, order_id, recurring_plan_id, is_auto)
           VALUES ($1, $2, $3, FALSE, $4, $5, TRUE)`,
          [worker_id, occurrence.date, shiftType, order.id, plan.id]
        );
      }

      orders.push(order);
    }

    await client.query('COMMIT');
    inTransaction = false;

    res.status(201).json({
      message: '常护安排创建成功，已生成未来四周订单',
      plan,
      orders,
    });
  } catch (error: any) {
    if (client && inTransaction) {
      await client.query('ROLLBACK');
    }

    if (error?.code === '23505') {
      return res.status(409).json(conflictResponse(attemptedWeek || 1, attemptedDate || occurrences[0].date));
    }

    sendServerError(res, error);
  } finally {
    client?.release();
  }
});

router.get(['/', '/my'], authenticate, requireRole('child'), async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT p.*,
              e.name AS elderly_name,
              w.real_name AS worker_name,
              COALESCE(
                json_agg(cn ORDER BY cn.recurrence_week) FILTER (WHERE cn.id IS NOT NULL),
                '[]'
              ) AS orders
       FROM recurring_care_plans p
       JOIN elderly_profiles e ON p.elderly_id = e.id
       JOIN users w ON p.worker_id = w.id
       LEFT JOIN care_needs cn ON cn.recurring_plan_id = p.id
       WHERE p.child_id = $1
       GROUP BY p.id, e.name, w.real_name
       ORDER BY p.created_at DESC`,
      [req.user?.id]
    );

    res.json(result.rows);
  } catch (error) {
    sendServerError(res, error);
  }
});

export default router;
