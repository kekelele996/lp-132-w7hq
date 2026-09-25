import { useEffect, useState } from 'react';
import { Button, Card, Form, Input, InputNumber, List, message, Modal, Select, Space, Tag } from 'antd';
import { CalendarOutlined, UserOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useLocation } from 'react-router-dom';
import { careNeedsApi, elderlyApi, recurringCareApi, userApi } from '../services/api';

const { Option } = Select;
const { TextArea } = Input;

const weekdayOptions = [
  { value: 1, label: '每周一' },
  { value: 2, label: '每周二' },
  { value: 3, label: '每周三' },
  { value: 4, label: '每周四' },
  { value: 5, label: '每周五' },
  { value: 6, label: '每周六' },
  { value: 7, label: '每周日' },
];

const shiftOptions = [
  { value: 'morning', label: '早班 08:00-12:00', color: 'blue' },
  { value: 'afternoon', label: '午班 12:00-18:00', color: 'green' },
  { value: 'evening', label: '晚班 18:00-22:00', color: 'orange' },
  { value: 'full', label: '全天 08:00-18:00', color: 'purple' },
];

const statusMap: Record<string, { label: string; color: string }> = {
  pending: { label: '待接单', color: 'orange' },
  accepted: { label: '已安排', color: 'blue' },
  in_progress: { label: '进行中', color: 'processing' },
  completed: { label: '已完成', color: 'green' },
  cancelled: { label: '已取消', color: 'default' },
};

const RecurringCare = () => {
  const [form] = Form.useForm();
  const location = useLocation();
  const [elderlyList, setElderlyList] = useState<any[]>([]);
  const [workers, setWorkers] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchPlans = async () => {
    try {
      const response = await recurringCareApi.getMy();
      setPlans(response.data);
    } catch (error) {
      message.error('获取常护安排失败');
    }
  };

  useEffect(() => {
    const fetchOptions = async () => {
      try {
        const [elderlyResponse, workerResponse] = await Promise.all([
          elderlyApi.getList(),
          userApi.getWorkers({ page: 1, limit: 100 }),
        ]);
        setElderlyList(elderlyResponse.data);
        setWorkers(workerResponse.data.workers || []);

        const workerId = (location.state as { workerId?: string } | null)?.workerId;
        if (workerId) {
          form.setFieldsValue({ worker_id: workerId });
        }
      } catch (error) {
        message.error('获取老人或护工列表失败');
      }
    };

    fetchOptions();
    fetchPlans();
  }, [form, location.state]);

  const handleSubmit = async (values: any) => {
    setLoading(true);
    try {
      const response = await recurringCareApi.create(values);
      const dates = (response.data.orders || [])
        .map((order: any) => dayjs(order.start_time).format('MM月DD日 HH:mm'))
        .join('、');

      Modal.success({
        title: '常护安排成功',
        content: `已一次生成未来四周订单：${dates}`,
      });
      form.resetFields();
      fetchPlans();
    } catch (error: any) {
      message.error(error.response?.data?.message || '常护安排失败');
    } finally {
      setLoading(false);
    }
  };

  const handleCancelOrder = (order: any) => {
    Modal.confirm({
      title: '取消本周常护',
      content: `只取消 ${dayjs(order.start_time).format('YYYY-MM-DD HH:mm')} 这一单，其余周次不受影响。确认取消吗？`,
      onOk: async () => {
        try {
          await careNeedsApi.cancel(order.id);
          message.success('本周订单已取消，该时段已释放');
          fetchPlans();
        } catch (error: any) {
          message.error(error.response?.data?.message || '取消失败');
        }
      },
    });
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800">常护安排</h1>
        <p className="text-gray-500 mt-1">选择老人、护工、每周星期和时段，一次生成未来四周订单。</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card title="新建常护安排" className="xl:col-span-1">
          <Form
            form={form}
            layout="vertical"
            onFinish={handleSubmit}
            initialValues={{ weekday: 1, shift_type: 'morning', price: 80 }}
          >
            <Form.Item
              name="elderly_id"
              label="选择老人"
              rules={[{ required: true, message: '请选择老人' }]}
            >
              <Select placeholder="请选择老人">
                {elderlyList.map((elderly) => (
                  <Option key={elderly.id} value={elderly.id}>
                    {elderly.name}（{elderly.age}岁）
                  </Option>
                ))}
              </Select>
            </Form.Item>

            <Form.Item
              name="worker_id"
              label="选择护工"
              rules={[{ required: true, message: '请选择护工' }]}
            >
              <Select placeholder="请选择护工" showSearch optionFilterProp="children">
                {workers.map((worker) => (
                  <Option key={worker.id} value={worker.id}>
                    {worker.real_name}（评分 {worker.rating}）
                  </Option>
                ))}
              </Select>
            </Form.Item>

            <Form.Item
              name="weekday"
              label="每周星期"
              rules={[{ required: true, message: '请选择每周星期' }]}
            >
              <Select options={weekdayOptions} />
            </Form.Item>

            <Form.Item
              name="shift_type"
              label="服务时段"
              rules={[{ required: true, message: '请选择服务时段' }]}
            >
              <Select>
                {shiftOptions.map((shift) => (
                  <Option key={shift.value} value={shift.value}>
                    {shift.label}
                  </Option>
                ))}
              </Select>
            </Form.Item>

            <Form.Item name="price" label="单次价格（元）">
              <InputNumber min={0} step={10} style={{ width: '100%' }} />
            </Form.Item>

            <Form.Item name="description" label="照护说明">
              <TextArea rows={3} placeholder="可填写照护重点、注意事项（选填）" />
            </Form.Item>

            <Button type="primary" htmlType="submit" loading={loading} block icon={<CalendarOutlined />}>
              生成未来四周订单
            </Button>
          </Form>
        </Card>

        <Card title="我的常护安排" className="xl:col-span-2">
          <List
            dataSource={plans}
            locale={{ emptyText: '暂无常护安排' }}
            renderItem={(plan: any) => (
              <List.Item>
                <div className="w-full">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <Space wrap>
                        <Tag icon={<UserOutlined />} color="blue">{plan.elderly_name}</Tag>
                        <Tag color="green">护工：{plan.worker_name}</Tag>
                        <Tag color="orange">
                          {weekdayOptions.find((item) => item.value === (plan.weekday === 0 ? 7 : plan.weekday))?.label}
                        </Tag>
                        <Tag color={shiftOptions.find((item) => item.value === plan.shift_type)?.color}>
                          {shiftOptions.find((item) => item.value === plan.shift_type)?.label}
                        </Tag>
                      </Space>
                      <div className="text-gray-500 text-sm mt-2">{plan.description}</div>
                    </div>
                    <span className="text-gray-400 text-sm">
                      创建于 {dayjs(plan.created_at).format('YYYY-MM-DD')}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                    {(plan.orders || []).map((order: any) => (
                      <div key={order.id} className="border rounded-lg p-3 bg-gray-50">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div className="font-medium">第{order.recurrence_week}周</div>
                            <div className="text-sm text-gray-500">
                              {dayjs(order.start_time).format('YYYY-MM-DD HH:mm')}
                            </div>
                          </div>
                          <Space>
                            <Tag color={statusMap[order.status]?.color}>
                              {statusMap[order.status]?.label}
                            </Tag>
                            {order.status === 'accepted' && (
                              <Button size="small" danger onClick={() => handleCancelOrder(order)}>
                                取消本周
                              </Button>
                            )}
                          </Space>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </List.Item>
            )}
          />
        </Card>
      </div>
    </div>
  );
};

export default RecurringCare;
