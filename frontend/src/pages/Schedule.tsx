import { useState, useEffect } from 'react';
import { Card, Calendar, Badge, Button, Modal, Form, Select, Switch, message, List, Tag, Input, Space } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { careNeedsApi, scheduleApi } from '../services/api';

const { Option } = Select;

const shiftTypeMap: Record<string, { label: string; color: string }> = {
  morning: { label: '早班 (08:00-12:00)', color: 'blue' },
  afternoon: { label: '午班 (12:00-18:00)', color: 'green' },
  evening: { label: '晚班 (18:00-22:00)', color: 'orange' },
  full: { label: '全天 (08:00-18:00)', color: 'purple' },
};

const orderStatusMap: Record<string, { label: string; color: string }> = {
  pending: { label: '待接单', color: 'orange' },
  accepted: { label: '待开始', color: 'blue' },
  in_progress: { label: '进行中', color: 'processing' },
  completed: { label: '已完成', color: 'green' },
  cancelled: { label: '已取消', color: 'default' },
};

const Schedule = () => {
  const [schedules, setSchedules] = useState<any[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Dayjs | null>(null);
  const [currentMonth, setCurrentMonth] = useState<Dayjs>(dayjs());
  const [form] = Form.useForm();

  const fetchSchedules = async (date: Dayjs = currentMonth) => {
    try {
      const params = {
        start_date: date.startOf('month').format('YYYY-MM-DD'),
        end_date: date.endOf('month').format('YYYY-MM-DD'),
      };
      const response = await scheduleApi.getMySchedules(params);
      setSchedules(response.data);
    } catch (error) {
      message.error('获取排班失败');
    }
  };

  useEffect(() => {
    fetchSchedules(dayjs());
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
    setCurrentMonth(date);
    fetchSchedules(date);
  };

  const handleSubmit = async (values: any) => {
    try {
      await scheduleApi.create(values);
      message.success('添加成功');
      setModalOpen(false);
      form.resetFields();
      fetchSchedules(currentMonth);
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
          fetchSchedules(currentMonth);
        } catch (error) {
          message.error('删除失败');
        }
      },
    });
  };

  const handleStart = async (orderId: string) => {
    try {
      await careNeedsApi.start(orderId);
      message.success('服务已开始');
      fetchSchedules(currentMonth);
    } catch (error: any) {
      message.error(error.response?.data?.message || '开始失败');
    }
  };

  const handleComplete = async (orderId: string) => {
    try {
      await careNeedsApi.complete(orderId);
      message.success('服务已完成');
      fetchSchedules(currentMonth);
    } catch (error: any) {
      message.error(error.response?.data?.message || '完成失败');
    }
  };

  const handleCancelOrder = (item: any) => {
    Modal.confirm({
      title: '取消本周常护',
      content: '只会取消并释放这一周的时段，其余周次不受影响。确认取消吗？',
      onOk: async () => {
        try {
          await careNeedsApi.cancel(item.order_id);
          message.success('本周订单已取消，时段已释放');
          fetchSchedules(currentMonth);
        } catch (error: any) {
          message.error(error.response?.data?.message || '取消失败');
        }
      },
    });
  };

  const getDateListData = (value: Dayjs) => {
    const dateStr = value.format('YYYY-MM-DD');
    return schedules
      .filter((schedule) => dayjs(schedule.date).format('YYYY-MM-DD') === dateStr)
      .map((schedule) => ({
        type: schedule.order_id ? 'success' : schedule.is_available ? 'warning' : 'default',
        content: schedule.order_id
          ? `${shiftTypeMap[schedule.shift_type]?.label || schedule.shift_type} · ${schedule.order_title}`
          : shiftTypeMap[schedule.shift_type]?.label || schedule.shift_type,
      }));
  };

  const dateCellRender = (value: Dayjs) => {
    const listData = getDateListData(value);
    return (
      <ul className="p-0 m-0">
        {listData.map((item, index) => (
          <li key={index} className="text-xs mb-1 truncate">
            <Badge status={item.type as any} text={item.content} />
          </li>
        ))}
      </ul>
    );
  };

  const getScheduleActions = (item: any) => {
    if (!item.order_id) {
      return [
        <Button
          key="delete"
          type="link"
          danger
          size="small"
          icon={<DeleteOutlined />}
          onClick={() => handleDelete(item.id)}
        >
          删除
        </Button>,
      ];
    }

    const actions = [];
    if (item.order_status === 'accepted') {
      actions.push(
        <Button key="start" type="primary" size="small" onClick={() => handleStart(item.order_id)}>
          开始
        </Button>,
        <Button key="cancel" danger size="small" onClick={() => handleCancelOrder(item)}>
          取消本周
        </Button>
      );
    }
    if (item.order_status === 'in_progress') {
      actions.push(
        <Button key="complete" type="primary" size="small" onClick={() => handleComplete(item.order_id)}>
          完成
        </Button>
      );
    }
    return actions;
  };

  return (
    <div>
      <div className="mb-6 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">排班日历</h1>
          <p className="text-gray-500 mt-1">常护安排会自动出现在对应日期和时段，可逐单开始、完成或取消。</p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => handleDateSelect(dayjs())}>
          添加排班
        </Button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card className="xl:col-span-2">
          <Calendar
            dateCellRender={dateCellRender}
            onSelect={handleDateSelect}
            onPanelChange={handlePanelChange}
          />
        </Card>

        <Card title="我的排班与常护任务">
          <List
            dataSource={schedules.filter((s) => dayjs(s.date).isAfter(dayjs().subtract(1, 'day')))}
            renderItem={(item) => (
              <List.Item actions={getScheduleActions(item)}>
                <List.Item.Meta
                  title={
                    <Space wrap>
                      <span>{dayjs(item.date).format('YYYY-MM-DD')}</span>
                      <Tag color={shiftTypeMap[item.shift_type]?.color}>
                        {shiftTypeMap[item.shift_type]?.label}
                      </Tag>
                      {item.order_status && (
                        <Tag color={orderStatusMap[item.order_status]?.color}>
                          {orderStatusMap[item.order_status]?.label}
                        </Tag>
                      )}
                    </Space>
                  }
                  description={
                    item.order_id ? (
                      <div className="space-y-1 text-sm">
                        <div className="font-medium text-gray-700">{item.order_title}</div>
                        <div>老人：{item.elderly_name || '-'}</div>
                        <div>家属：{item.child_name || '-'}</div>
                        <div className="text-gray-500 truncate">地址：{item.order_address || '-'}</div>
                      </div>
                    ) : (
                      <div className="mt-1 text-sm">
                        {item.is_available ? (
                          <Tag color="orange">可接单</Tag>
                        ) : (
                          <Tag color="default">休息</Tag>
                        )}
                      </div>
                    )
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
