import { Router, Response } from 'express';
import pool from '../config/database';
import { sendServerError } from '../utils/httpResponses';
import { AuthRequest, authenticate, requireRole } from '../middleware/auth';

const router = Router();

const WEEK_COUNT = 4;
// 常护订单一生成即为护工锁定，进入“已接单”状态，护工可直接开始、完成
const ACTIVE_STATUSES = ['pending', 'accepted', 'in_progress'];

/**
 * 按东八区取“今天”的日期（年、月、日），避免容器 UTC 时区导致星期/日期偏差
 */
const getShanghaiDateParts = (): [number, number, number] => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return [get('year'), get('month'), get('day')];
};

/**
 * 生成未来四周的服务日期：从“下一个符合所选星期的日期”开始，每周一次，共四周。
 * weekday: 1（周一）~ 7（周日）
 */
const buildWeekDates = (weekday: number): Date[] => {
  const [year, month, day] = getShanghaiDateParts();
  const today = new Date(Date.UTC(year, month - 1, day));
  // JS getUTCDay(): 周日为 0，转成周一为 1
  const todayWeekday = today.getUTCDay() === 0 ? 7 : today.getUTCDay();
  let delta = weekday - todayWeekday;
  if (delta <= 0) {
    delta += 7;
  }
  const dates: Date[] = [];
  for (let i = 0; i < WEEK_COUNT; i++) {
    const d = new Date(today.getTime());
    d.setUTCDate(today.getUTCDate() + delta + i * 7);
    dates.push(d);
  }
  return dates;
};

const formatDate = (d: Date): string => d.toISOString().slice(0, 10);

const isValidHHmm = (value: unknown): value is string =>
  typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

// 家属创建常护安排：一次生成未来四周订单；任一周冲突则整单不保存
router.post('/', authenticate, requireRole('child'), async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const {
      elderly_id,
      worker_id,
      weekday,
      start_time_str,
      end_time_str,
      title,
      description,
      care_type,
      address,
      duration_hours,
      price,
    } = req.body;

    const weekdayNum = Number(weekday);
    if (
      !elderly_id ||
      !worker_id ||
      !Number.isInteger(weekdayNum) ||
      weekdayNum < 1 ||
      weekdayNum > 7 ||
      !isValidHHmm(start_time_str) ||
      !isValidHHmm(end_time_str) ||
      !title ||
      !description ||
      !care_type ||
      !address
    ) {
      return res.status(400).json({ message: '请完整填写老人、护工、每周星期和服务时段' });
    }

    if (start_time_str >= end_time_str) {
      return res.status(400).json({ message: '服务时段开始时间需早于结束时间' });
    }

    const weekDates = buildWeekDates(weekdayNum);
    const slots = weekDates.map((d, index) => ({
      week: index + 1,
      date: formatDate(d),
      start: `${formatDate(d)} ${start_time_str}:00`,
      end: `${formatDate(d)} ${end_time_str}:00`,
    }));

    try {
      await client.query('BEGIN');

      // 参数校验放在事务内，保证与插入动作在同一事务里完成
      const elderlyCheck = await client.query(
        'SELECT id FROM elderly_profiles WHERE id = $1 AND child_id = $2',
        [elderly_id, req.user?.id]
      );
      if (elderlyCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: '老人档案不存在或无权限' });
      }

      const workerCheck = await client.query(
        "SELECT id FROM users WHERE id = $1 AND role IN ('worker', 'volunteer')",
        [worker_id]
      );
      if (workerCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: '护工不存在' });
      }

      // 以护工为粒度加事务级咨询锁：两个家属并发安排同一护工时排队执行，
      // 后提交的请求一定能看到先提交的订单，保证同一时段只留下一份
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':recurring_arrangement', 0))",
        [worker_id]
      );

      // 检查护工已有未结束订单是否落在任一时段
      const conflictWeeks: { week: number; date: string }[] = [];
      for (const slot of slots) {
        const overlap = await client.query(
          `SELECT id
             FROM care_needs
            WHERE worker_id = $1
              AND status = ANY($2)
              AND start_time < $4
              AND COALESCE(end_time, start_time + INTERVAL '1 hour') > $3
            LIMIT 1`,
          [worker_id, ACTIVE_STATUSES, slot.start, slot.end]
        );
        if (overlap.rows.length > 0) {
          conflictWeeks.push({ week: slot.week, date: slot.date });
        }
      }

      if (conflictWeeks.length > 0) {
        await client.query('ROLLBACK');
        const detail = conflictWeeks
          .map((c) => `第${c.week}周(${c.date})`)
          .join('、');
        return res.status(409).json({
          message: `护工在以下时段已有未结束订单：${detail}，本次安排未保存，请调整星期或时段后重试`,
          conflict_weeks: conflictWeeks,
        });
      }

      const arrangementResult = await client.query(
        `INSERT INTO recurring_arrangements
           (child_id, elderly_id, worker_id, title, description, care_type, address,
            weekday, start_time_str, end_time_str, duration_hours, price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          req.user?.id,
          elderly_id,
          worker_id,
          title,
          description,
          care_type,
          address,
          weekdayNum,
          start_time_str,
          end_time_str,
          duration_hours ?? null,
          price ?? null,
        ]
      );
      const arrangement = arrangementResult.rows[0];

      const createdNeeds: any[] = [];
      for (const slot of slots) {
        try {
          const needResult = await client.query(
            `INSERT INTO care_needs
               (child_id, elderly_id, title, description, care_type, start_time, end_time,
                address, duration_hours, price, status, worker_id, accepted_at,
                recurring_arrangement_id, week_index)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'accepted', $11,
                     CURRENT_TIMESTAMP, $12, $13)
             RETURNING *`,
            [
              req.user?.id,          // 1
              elderly_id,            // 2
              title,                 // 3
              description,           // 4
              care_type,             // 5
              slot.start,            // 6
              slot.end,              // 7
              address,               // 8
              duration_hours ?? null, // 9
              price ?? null,         // 10
              worker_id,             // 11
              arrangement.id,        // 12
              slot.week,             // 13
            ]
          );
          createdNeeds.push(needResult.rows[0]);
        } catch (e: any) {
          // 兜底：数据库排他约束防住咨询锁之外的写入路径（如并发抢单）
          if (e.code === '23P01') {
            await client.query('ROLLBACK');
            return res.status(409).json({
              message: `护工第${slot.week}周(${slot.date})时段已被其他订单占用，请调整后重试`,
              conflict_weeks: [{ week: slot.week, date: slot.date }],
            });
          }
          throw e;
        }
      }

      await client.query('COMMIT');

      res.status(201).json({
        message: `常护安排成功，已生成未来${WEEK_COUNT}周订单`,
        arrangement,
        needs: createdNeeds,
      });
    } catch (txError) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw txError;
    }
  } catch (error) {
    sendServerError(res, error);
  } finally {
    client.release();
  }
});

// 家属查看自己的常护安排及各周订单
router.get('/mine', authenticate, requireRole('child'), async (req: AuthRequest, res: Response) => {
  try {
    const arrangements = await pool.query(
      `SELECT ra.*, e.name AS elderly_name, w.real_name AS worker_name, w.phone AS worker_phone
         FROM recurring_arrangements ra
         JOIN elderly_profiles e ON ra.elderly_id = e.id
         JOIN users w ON ra.worker_id = w.id
        WHERE ra.child_id = $1
        ORDER BY ra.created_at DESC`,
      [req.user?.id]
    );

    const needs = arrangements.rows.length
      ? await pool.query(
          `SELECT * FROM care_needs
            WHERE recurring_arrangement_id = ANY($1::uuid[])
            ORDER BY week_index ASC`,
          [arrangements.rows.map((a: any) => a.id)]
        )
      : { rows: [] };

    const grouped = arrangements.rows.map((a: any) => ({
      ...a,
      needs: needs.rows.filter((n: any) => n.recurring_arrangement_id === a.id),
    }));

    res.json(grouped);
  } catch (error) {
    sendServerError(res, error);
  }
});

// 护工查看由常护安排生成的任务（排班页使用）
router.get('/my-tasks', authenticate, requireRole('worker', 'volunteer'), async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT cn.*, e.name AS elderly_name, e.gender AS elderly_gender, e.age AS elderly_age,
              e.phone AS elderly_phone, e.address AS elderly_address,
              u.real_name AS child_name, u.phone AS child_phone
         FROM care_needs cn
         JOIN elderly_profiles e ON cn.elderly_id = e.id
         JOIN users u ON cn.child_id = u.id
        WHERE cn.worker_id = $1
          AND cn.recurring_arrangement_id IS NOT NULL
          AND cn.status <> 'cancelled'
        ORDER BY cn.start_time ASC`,
      [req.user?.id]
    );
    res.json(result.rows);
  } catch (error) {
    sendServerError(res, error);
  }
});

export default router;
