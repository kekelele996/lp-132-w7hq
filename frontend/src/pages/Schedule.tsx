import { useState, useEffect } from 'react';
import { Card, Calendar, Badge, Button, Modal, Form, Select, Switch, message, List, Tag, Input, Empty } from 'antd';
import { PlusOutlined, DeleteOutlined, PlayCircleOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { scheduleApi, recurringApi, careNeedsApi } from '../services/api';

const { Option } = Select;

const shiftTypeMap: Record<string, { label: string; color: string }> = {
  morning: { label: '早班 (08:00-12:00)', color: 'blue' },
  afternoon: { label: '午班 (12:00-18:00)', color: 'green' },
  evening: { label: '晚班 (18:00-22:00)', color: 'orange' },
  full: { label: '全天 (08:00-18:00)', color: 'purple' },
};

const taskStatusMap: Record<string, { label: string; color: string }> = {
  pending: { label: '待接单', color: 'orange' },
  accepted: { label: '待开始', color: 'blue' },
  in_progress: { label: '进行中', color: 'processing' },
  completed: { label: '已完成', color: 'green' },
  cancelled: { label: '已取消', color: 'default' },
};

const Schedule = () => {
  const [schedules, setSchedules] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Dayjs | null>(null);
  const [form] = Form.useForm();
  const [monthSchedules, setMonthSchedules] = useState<any[]>([]);

  const fetchSchedules = async (date?: Dayjs) => {
    try {
      const params: any = {};
      if (date) {
        params.start_date = date.startOf('month').format('YYYY-MM-DD');
        params.end_date = date.endOf('month').format('YYYY-MM-DD');
      }
      const response = await scheduleApi.getMySchedules(params);
      setSchedules(response.data);
      setMonthSchedules(response.data);
    } catch (error) {
      message.error('获取排班失败');
    }
  };

  const fetchTasks = async () => {
    try {
      const response = await recurringApi.getMyTasks();
      setTasks(response.data);
    } catch (error) {
      message.error('获取常护任务失败');
    }
  };

  useEffect(() => {
    fetchSchedules(dayjs());
    fetchTasks();
  }, []);

  const handleDateSelect = (date: Dayjs) => {
    setSelectedDate(date);
    form.setFieldsValue({
      date: date.format('YYYY-MM-DD'),
      shift_type: 'morning',
      is_available: true,
    });
    setModalOpen(true);
  };

  const handlePanelChange = (date: Dayjs) => {
    fetchSchedules(date);
  };

  const handleSubmit = async (values: any) => {
    try {
      await scheduleApi.create(values);
      message.success('添加成功');
      setModalOpen(false);
      form.resetFields();
      fetchSchedules(dayjs());
    } catch (error: any) {
      message.error(error.response?.data?.message || '添加失败');
    }
  };

  const handleDelete = async (id: string) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除这个排班吗？',
      onOk: async () => {
        try {
          await scheduleApi.delete(id);
          message.success('删除成功');
          fetchSchedules(dayjs());
        } catch (error) {
          message.error('删除失败');
        }
      },
    });
  };

  const handleStart = async (task: any) => {
    try {
      await careNeedsApi.start(task.id);
      message.success('服务已开始');
      fetchTasks();
    } catch (error: any) {
      message.error(error.response?.data?.message || '操作失败');
    }
  };

  const handleComplete = async (task: any) => {
    try {
      await careNeedsApi.complete(task.id);
      message.success('服务已完成');
      fetchTasks();
    } catch (error: any) {
      message.error(error.response?.data?.message || '操作失败');
    }
  };

  const handleCancelTask = (task: any) => {
    Modal.confirm({
      title: `取消第${task.week_index}周服务`,
      content: `仅取消 ${dayjs(task.start_time).format('YYYY-MM-DD HH:mm')} 这一时段，该时段将释放，其余周次任务不受影响。确定取消吗？`,
      okText: '取消该周',
      okButtonProps: { danger: true },
      cancelText: '再想想',
      onOk: async () => {
        try {
          await careNeedsApi.cancel(task.id);
          message.success('已取消该周服务');
          fetchTasks();
        } catch (error: any) {
          message.error(error.response?.data?.message || '取消失败');
        }
      },
    });
  };

  const getDateListData = (value: Dayjs) => {
    const dateStr = value.format('YYYY-MM-DD');
    const daySchedules = monthSchedules.filter(
      (s) => dayjs(s.date).format('YYYY-MM-DD') === dateStr
    );
    const items = daySchedules.map((s) => ({
      type: s.order_id ? 'success' : s.is_available ? 'warning' : 'default',
      content: shiftTypeMap[s.shift_type]?.label || s.shift_type,
    }));
    // 当天的常护任务也展示在日历上
    tasks
      .filter((t) => dayjs(t.start_time).format('YYYY-MM-DD') === dateStr)
      .forEach((t) => {
        items.push({
          type: t.status === 'completed' ? 'success' : 'processing',
          content: `常护 ${dayjs(t.start_time).format('HH:mm')} ${t.elderly_name}`,
        });
      });
    return items;
  };

  const dateCellRender = (value: Dayjs) => {
    const listData = getDateListData(value);
    return (
      <ul className="p-0 m-0">
        {listData.map((item, index) => (
          <li key={index} className="text-xs mb-1">
            <Badge status={item.type as any} text={item.content} />
          </li>
        ))}
      </ul>
    );
  };

  const upcomingTasks = tasks.filter((t) =>
    dayjs(t.start_time).isAfter(dayjs().subtract(1, 'day'))
  );

  return (
    <div>
      <div className="mb-6 flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-800">排班日历</h1>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => handleDateSelect(dayjs())}>
          添加排班
        </Button>
      </div>

      <Card
        title="常护任务"
        className="mb-6"
        extra={<span className="text-sm text-gray-400">家属通过常护安排生成，逐周开始 / 完成；取消一周只释放该时段</span>}
      >
        {upcomingTasks.length === 0 ? (
          <Empty description="暂无常护任务" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <List
            grid={{ gutter: 16, xs: 1, sm: 1, md: 2, lg: 2, xl: 3, xxl: 4 }}
            dataSource={upcomingTasks}
            renderItem={(task) => (
              <List.Item>
                <Card size="small" className="w-full">
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-medium">{task.title}</span>
                    <Tag color={taskStatusMap[task.status]?.color}>{taskStatusMap[task.status]?.label}</Tag>
                  </div>
                  <div className="text-sm text-gray-500 space-y-1 mb-3">
                    <div>
                      <Tag color="purple">第{task.week_index}周</Tag>
                      {dayjs(task.start_time).format('YYYY-MM-DD ddd HH:mm')}-
                      {dayjs(task.end_time).format('HH:mm')}
                    </div>
                    <div>老人：{task.elderly_name}（{task.elderly_gender}，{task.elderly_age}岁）</div>
                    <div className="truncate">地址：{task.address}</div>
                    <div>家属：{task.child_name} {task.child_phone}</div>
                  </div>
                  <div className="flex justify-end space-x-2">
                    {task.status === 'accepted' && (
                      <Button
                        type="primary"
                        size="small"
                        icon={<PlayCircleOutlined />}
                        onClick={() => handleStart(task)}
                      >
                        开始
                      </Button>
                    )}
                    {task.status === 'in_progress' && (
                      <Button
                        type="primary"
                        size="small"
                        icon={<CheckCircleOutlined />}
                        onClick={() => handleComplete(task)}
                      >
                        完成
                      </Button>
                    )}
                    {['pending', 'accepted'].includes(task.status) && (
                      <Button
                        danger
                        size="small"
                        icon={<CloseCircleOutlined />}
                        onClick={() => handleCancelTask(task)}
                      >
                        取消该周
                      </Button>
                    )}
                  </div>
                </Card>
              </List.Item>
            )}
          />
        )}
      </Card>

      <div className="grid grid-cols-3 gap-6">
        <Card className="col-span-2">
          <Calendar
            dateCellRender={dateCellRender}
            onSelect={handleDateSelect}
            onPanelChange={handlePanelChange}
          />
        </Card>

        <Card title="我的排班">
          <List
            dataSource={schedules.filter((s) => dayjs(s.date).isAfter(dayjs().subtract(1, 'day')))}
            renderItem={(item) => (
              <List.Item
                actions={[
                  !item.order_id && (
                    <Button
                      type="link"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      onClick={() => handleDelete(item.id)}
                    >
                      删除
                    </Button>
                  ),
                ].filter(Boolean)}
              >
                <List.Item.Meta
                  title={dayjs(item.date).format('YYYY-MM-DD')}
                  description={
                    <div>
                      <Tag color={shiftTypeMap[item.shift_type]?.color}>
                        {shiftTypeMap[item.shift_type]?.label}
                      </Tag>
                      <div className="mt-1 text-sm">
                        {item.order_id ? (
                          <Tag color="green">有订单</Tag>
                        ) : item.is_available ? (
                          <Tag color="orange">可接单</Tag>
                        ) : (
                          <Tag color="default">休息</Tag>
                        )}
                      </div>
                    </div>
                  }
                />
              </List.Item>
            )}
            locale={{ emptyText: '暂无排班' }}
          />
        </Card>
      </div>

      <Modal
        title="添加排班"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        footer={null}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="date" label="日期" hidden>
            <Input />
          </Form.Item>

          <div className="mb-4 p-3 bg-gray-50 rounded-lg">
            <span className="text-gray-600">排班日期：</span>
            <span className="font-medium ml-2">{selectedDate?.format('YYYY年MM月DD日')}</span>
          </div>

          <Form.Item
            name="shift_type"
            label="班次"
            rules={[{ required: true, message: '请选择班次' }]}
          >
            <Select placeholder="请选择班次">
              <Option value="morning">早班 (08:00-12:00)</Option>
              <Option value="afternoon">午班 (12:00-18:00)</Option>
              <Option value="evening">晚班 (18:00-22:00)</Option>
              <Option value="full">全天 (08:00-18:00)</Option>
            </Select>
          </Form.Item>

          <Form.Item name="is_available" label="是否可接单" valuePropName="checked">
            <Switch defaultChecked />
          </Form.Item>

          <Form.Item className="mb-0">
            <div className="flex justify-end space-x-3">
              <Button onClick={() => setModalOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit">添加</Button>
            </div>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Schedule;
