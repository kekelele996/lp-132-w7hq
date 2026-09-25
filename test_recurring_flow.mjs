/* eslint-disable no-console */
/**
 * 常护安排功能 - 端到端业务测试（Node 版，零外部依赖，使用内置 fetch）
 *
 * 覆盖需求：
 * 1. 家属选择老人、护工、每周星期和时段，系统一次生成未来四周订单
 * 2. 护工已有未结束订单落在同一时段时，整次提交不保存（409）并提示哪一周冲突
 * 3. 两个家属同时安排到同一护工同一时段时只能留下一份（并发）
 * 4. 护工在排班页看到这些任务并逐单开始、完成
 * 5. 取消其中一周只释放该时段，其余周次不受影响；完成/取消后时段释放
 *
 * 运行：node test_recurring_flow.mjs
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3232/api';

const pass = [];
const fail = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass.push(name);
    console.log(`  ✓ ${name}`);
  } else {
    fail.push(`${name} ${detail}`);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

async function api(method, path, token, body) {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await resp.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: resp.status, data };
}

async function login(username, password = '123456') {
  const { data } = await api('POST', '/auth/login', null, { username, password });
  const payload = JSON.parse(Buffer.from(data.token.split('.')[1], 'base64').toString());
  return { token: data.token, id: payload.id, username };
}

// weekday: 1=周一 ... 7=周日；与后端一致：下一个符合星期的日期起共四周
function nextWeekdayDates(weekday) {
  const now = new Date();
  // 东八区“今天”
  const shanghai = new Date(now.getTime() + 8 * 3600 * 1000);
  const today = new Date(Date.UTC(
    shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate()));
  const jsDay = today.getUTCDay();
  const todayWd = jsDay === 0 ? 7 : jsDay;
  let delta = weekday - todayWd;
  if (delta <= 0) delta += 7;
  return Array.from({ length: 4 }, (_, i) => {
    const d = new Date(today.getTime());
    d.setUTCDate(today.getUTCDate() + delta + 7 * i);
    return d.toISOString().slice(0, 10);
  });
}

async function createArrangement(token, payload) {
  return api('POST', '/recurring', token, payload);
}

async function main() {
  console.log('='.repeat(64));
  console.log('常护安排功能 - 端到端测试');
  console.log('='.repeat(64));

  const child1 = await login('child1');
  const child2 = await login('child2');
  const worker1 = await login('worker1');
  const worker2 = await login('worker2');
  console.log('✓ child1 / child2 / worker1 / worker2 登录成功');

  const { data: elderlyList } = await api('GET', '/elderly', child1.token);
  const elderlyId = elderlyList[0].id;
  const { data: child2Elderly } = await api('GET', '/elderly', child2.token);
  const child2ElderlyId = child2Elderly[0].id;

  // 用当前小时滚动选择一个几乎不会与历史运行冲突的时段（未来日期本身也在变）
  const minute = (new Date().getMinutes() % 3) * 15;
  const slotStart = `08:${String(minute).padStart(2, '0')}`;
  const slotEnd = `09:${String(minute).padStart(2, '0')}`;

  // weekday：今天的星期（东八区）
  const shNow = new Date(Date.now() + 8 * 3600 * 1000);
  const jsDay = shNow.getUTCDay();
  const weekday = jsDay === 0 ? 7 : jsDay;
  const dates = nextWeekdayDates(weekday);

  const basePayload = {
    elderly_id: elderlyId,
    worker_id: worker1.id,
    weekday,
    start_time_str: slotStart,
    end_time_str: slotEnd,
    title: '每周常护-康复护理',
    description: '每周上门做康复训练和血压监测',
    care_type: 'health_check',
    address: '北京市朝阳区幸福小区3号楼2单元501',
    duration_hours: 1,
    price: 100,
  };

  // ---------- 场景3：并发（先执行，使用 worker2 全新时段）----------
  console.log('\n--- 场景3：两个家属同时安排同一护工同时段，只能留下一份 ---');
  const w2Payload1 = { ...basePayload, worker_id: worker2.id, start_time_str: '08:45', end_time_str: '09:45' };
  const w2Payload2 = { ...w2Payload1, elderly_id: child2ElderlyId, title: '每周常护-另一家属' };

  const [rA, rB] = await Promise.all([
    createArrangement(child1.token, w2Payload1),
    createArrangement(child2.token, w2Payload2),
  ]);
  const codes = [rA.status, rB.status].sort((a, b) => a - b);
  check('并发两个请求一个 201 一个 409', codes[0] === 201 && codes[1] === 409,
    `实际: ${rA.status}/${rB.status} ${JSON.stringify(rA.data).slice(0, 120)}`);
  const loser = rA.status === 409 ? rA : rB;
  if (loser.status === 409) {
    check('失败方返回冲突周次(4周)', Array.isArray(loser.data.conflict_weeks) &&
      loser.data.conflict_weeks.length === 4, `实际: ${JSON.stringify(loser.data)}`);
  }

  const { data: w2Tasks } = await api('GET', '/recurring/my-tasks', worker2.token);
  const w2Slot = w2Tasks.filter((t) => t.start_time.slice(11, 16) === '08:45');
  const w2Dates = new Set(w2Slot.map((t) => t.start_time.slice(0, 10)));
  check('并发后每个日期只留下一份订单', w2Slot.length === 4 && w2Dates.size === 4,
    `实际 ${w2Slot.length} 单, ${w2Dates.size} 个日期`);

  // ---------- 场景1：正常生成四周订单 ----------
  console.log('\n--- 场景1：常护安排一次生成未来四周订单 ---');
  const r1 = await createArrangement(child1.token, basePayload);
  check('创建返回 201', r1.status === 201, `${r1.status} ${JSON.stringify(r1.data).slice(0, 200)}`);
  const needs = r1.data.needs || [];
  const arrangementId = r1.data.arrangement?.id;
  check('生成 4 个订单', needs.length === 4, `实际 ${needs.length}`);
  check('订单均为 accepted（护工已锁定）', needs.every((n) => n.status === 'accepted'));
  check('订单周次为 1-4', needs.map((n) => n.week_index).sort().join() === '1,2,3,4');
  const actualDates = needs.map((n) => n.start_time.slice(0, 10)).sort();
  check('服务日期为下一个该星期起连续四周',
    actualDates.join() === [...dates].sort().join(), `期望 ${dates} 实际 ${actualDates}`);
  check('订单时间为所选时段', needs.every((n) => n.start_time.slice(11, 16) === slotStart));

  const { data: mine } = await api('GET', '/recurring/mine', child1.token);
  const found = mine.find((a) => a.id === arrangementId);
  check('/mine 能看到安排及四周订单', !!found && found.needs.length === 4);

  const { data: tasks } = await api('GET', '/recurring/my-tasks', worker1.token);
  const taskIds = new Set(tasks.map((t) => t.id));
  check('护工排班页能看到四周常护任务', needs.every((n) => taskIds.has(n.id)));

  const { data: myOrders } = await api('GET', '/care-needs', worker1.token);
  const week1 = needs.find((n) => n.week_index === 1);
  check('常护订单出现在护工订单列表',
    myOrders.needs.some((o) => o.id === week1.id && o.status === 'accepted'));

  // ---------- 场景2：冲突时整次不保存并提示周次 ----------
  console.log('\n--- 场景2：护工同时段已有未结束订单，提交不保存并提示冲突周 ---');
  const r2 = await createArrangement(child1.token,
    { ...basePayload, title: '每周常护-冲突重试' });
  check('冲突返回 409', r2.status === 409, `实际 ${r2.status}`);
  const cw = (r2.data.conflict_weeks || []).map((c) => c.week).sort();
  check('四周全部报冲突', cw.join() === '1,2,3,4', `实际 ${cw}`);
  check('提示包含具体日期', (r2.data.conflict_weeks || []).every((c) => c.date));
  const { data: mine2 } = await api('GET', '/recurring/mine', child1.token);
  check('冲突提交没有保存任何安排/订单',
    mine2.every((a) => a.title !== '每周常护-冲突重试'));

  const r3 = await createArrangement(child1.token,
    { ...basePayload, start_time_str: '10:00', end_time_str: '11:00', title: '每周常护-另一时段' });
  check('不重叠时段可以安排成功', r3.status === 201, `${r3.status} ${JSON.stringify(r3.data).slice(0, 160)}`);

  const rAdj = await createArrangement(child1.token,
    { ...basePayload, start_time_str: slotEnd, end_time_str: '10:00', title: '每周常护-紧接时段' });
  check('前后紧接的时段允许安排', rAdj.status === 201, `${rAdj.status} ${JSON.stringify(rAdj.data).slice(0, 160)}`);

  // ---------- 场景5：取消单周只释放该时段 ----------
  console.log('\n--- 场景5：取消其中一周只释放该时段 ---');
  const week2 = needs.find((n) => n.week_index === 2);
  const cancelResp = await api('POST', `/care-needs/${week2.id}/cancel`, child1.token);
  check('取消第2周成功', cancelResp.status === 200, JSON.stringify(cancelResp.data).slice(0, 120));

  const { data: mineAfterCancel } = await api('GET', '/recurring/mine', child1.token);
  const arr = mineAfterCancel.find((a) => a.id === arrangementId);
  const st = Object.fromEntries(arr.needs.map((n) => [n.week_index, n.status]));
  check('第2周已取消', st[2] === 'cancelled', `实际 ${JSON.stringify(st)}`);
  check('其余三周不受影响', [1, 3, 4].every((w) => st[w] === 'accepted'),
    `实际 ${JSON.stringify(st)}`);

  const { data: tasksAfter } = await api('GET', '/recurring/my-tasks', worker1.token);
  const taskIdsAfter = new Set(tasksAfter.map((t) => t.id));
  check('护工任务列表不再显示已取消周', !taskIdsAfter.has(week2.id));
  check('其余周仍在护工任务列表',
    needs.filter((n) => [1, 3, 4].includes(n.week_index)).every((n) => taskIdsAfter.has(n.id)));

  // 再提交同时段：第2周空着，1/3/4 冲突 → 409 且只报 1,3,4
  const rRetry = await createArrangement(child1.token,
    { ...basePayload, title: '每周常护-部分冲突' });
  check('部分周冲突仍整体不保存', rRetry.status === 409, `${rRetry.status}`);
  if (rRetry.status === 409) {
    const partialWeeks = (rRetry.data.conflict_weeks || []).map((c) => c.week).sort();
    check('准确提示第1/3/4周冲突', partialWeeks.join() === '1,3,4', `实际 ${partialWeeks}`);
  }
  const { data: mine3 } = await api('GET', '/recurring/mine', child1.token);
  check('部分冲突提交未落库', mine3.every((a) => a.title !== '每周常护-部分冲突'));

  // ---------- 场景4：护工逐单开始、完成 ----------
  console.log('\n--- 场景4：护工逐单开始、完成 ---');
  const startResp = await api('POST', `/care-needs/${week1.id}/start`, worker1.token);
  check('第1周开始服务', startResp.status === 200, JSON.stringify(startResp.data).slice(0, 120));
  const completeResp = await api('POST', `/care-needs/${week1.id}/complete`, worker1.token);
  check('第1周完成服务', completeResp.status === 200, JSON.stringify(completeResp.data).slice(0, 120));

  // 第1周完成后该时段释放：再提交同时段应只剩 3,4 冲突
  const rRetry2 = await createArrangement(child1.token,
    { ...basePayload, title: '每周常护-完成后释放' });
  check('完成后该周时段释放（仍有冲突说明未释放）', rRetry2.status === 409);
  if (rRetry2.status === 409) {
    const remain = (rRetry2.data.conflict_weeks || []).map((c) => c.week).sort();
    check('只剩第3/4周冲突', remain.join() === '3,4', `实际 ${remain}`);
  }

  const { data: mine4 } = await api('GET', '/recurring/mine', child1.token);
  const arr4 = mine4.find((a) => a.id === arrangementId);
  const statusByWeek = Object.fromEntries(arr4.needs.map((n) => [n.week_index, n.status]));
  check('各周状态独立（1完成 2取消 3/4待开始）',
    statusByWeek[1] === 'completed' && statusByWeek[2] === 'cancelled' &&
    statusByWeek[3] === 'accepted' && statusByWeek[4] === 'accepted',
    `实际 ${JSON.stringify(statusByWeek)}`);

  const week3 = needs.find((n) => n.week_index === 3);
  const stranger = await api('POST', `/care-needs/${week3.id}/start`, worker2.token);
  check('其他护工不能开始别人的任务', stranger.status === 403, `实际 ${stranger.status}`);

  const { data: profile } = await api('GET', '/users/profile', worker1.token);
  check('完成订单计入护工单量', (profile.order_count || 0) >= 1,
    `order_count=${profile.order_count}`);

  // ---------- 参数校验 ----------
  console.log('\n--- 参数校验 ---');
  const bad1 = await createArrangement(child1.token, { ...basePayload, weekday: 9 });
  check('非法星期被拒绝', bad1.status === 400, `实际 ${bad1.status}`);
  const bad2 = await createArrangement(child1.token,
    { ...basePayload, start_time_str: '11:00', end_time_str: '10:00' });
  check('结束早于开始被拒绝', bad2.status === 400, `实际 ${bad2.status}`);
  const bad3 = await createArrangement(child1.token,
    { ...basePayload, elderly_id: child2ElderlyId });
  check('不能为别人的老人安排', bad3.status === 404, `实际 ${bad3.status}`);
  const bad4 = await createArrangement(worker1.token, basePayload);
  check('护工角色不能创建常护安排', bad4.status === 403, `实际 ${bad4.status}`);

  // ---------- 汇总 ----------
  console.log('\n' + '='.repeat(64));
  console.log(`通过 ${pass.length} 项，失败 ${fail.length} 项`);
  if (fail.length) {
    fail.forEach((f) => console.log('  FAIL:', f));
    process.exitCode = 1;
  } else {
    console.log('✓ 全部测试通过');
  }
}

main().catch((e) => {
  console.error('测试执行异常', e);
  process.exit(1);
});
