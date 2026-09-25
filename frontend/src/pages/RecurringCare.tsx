import { useState, useEffect } from 'react';
import {
  Card,
  Form,
  Input,
  Select,
  TimePicker,
  InputNumber,
  Button,
  message,
  Row,
  Col,
  List,
  Tag,
  Modal,
  Empty,
  Alert,
  Space,
} from 'antd';
import { CalendarOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { useLocation, useNavigate } from 'react-router-dom';
import { elderlyApi, favoriteApi, recurringApi, careNeedsApi } from '../services/api';

const { Option } = Select;
const { TextArea } = Input;

const careTypes = [
  { value: 'health_check', label: '健康检查' },
  { value: 'accompany', label: '陪同就医' },
  { value: 'daily_care', label: '日常照料' },
  { value: 'shopping', label: '代购代办' },
  { value: 'companionship', label: '聊天陪伴' },
  { value: 'other', label: '其他' },
];

const careTypeMap: Record<string, string> = Object.fromEntries(
  careTypes.map((t) => [t.value, t.label])
);

// weekday: 1（周一）~ 7（周日）
const weekdayOptions = [
  { value: 1, label: '每周一' },
  { value: 2, label: '每周二' },
  { value: 3, label: '每周三' },
  { value: 4, label: '每周四' },
  { value: 5, label: '每周五' },
  { value: 6, label: '每周六' },
  { value: 7, label: '每周日' },
];

const statusMap: Record<string, { label: string; color: string }> = {
  pending: { label: '待接单', color: 'orange' },
  accepted: { label: '待开始', color: 'blue' },
  in_progress: { label: '进行中', color: 'processing' },
  completed: { label: '已完成', color: 'green' },
  cancelled: { label: '已取消', color: 'default' },
};

// 与后端一致：下一个符合星期的日期起，共四周
const buildPreviewDates = (weekday: number): Dayjs[] => {
  const today = dayjs();
  const todayWeekday = today.day() === 0 ? 7 : today.day();
  let delta = weekday - todayWeekday;
  if (delta <= 0) {
    delta += 7;
  }
  return Array.from({ length: 4 }, (_, i) => today.add(delta + i * 7, 'day'));
};

const RecurringCare = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [form] = Form.useForm();
  const [elderlyList, setElderlyList] = useState<any[]>([]);
  const [workers, setWorkers] = useState<any[]>([]);
  const [arrangements, setArrangements] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ dates: Dayjs[]; range: [Dayjs, Dayjs] | null }>({
    dates: [],
    range: null,
  });

  const presetWorkerId = (location.state as { workerId?: string } | null)?.workerId;

  const fetchData = async () => {
    try {
      const [elderlyRes, workerRes, arrangementRes] = await Promise.all([
        elderlyApi.getList(),
        favoriteApi.getList(),
        recurringApi.getMine(),
      ]);
      setElderlyList(elderlyRes.data);
      setWorkers(workerRes.data);
      setArrangements(arrangementRes.data);
    } catch (error) {
      message.error('获取数据失败');
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const updatePreview = () => {
    const weekday = form.getFieldValue('weekday');
    const range = form.getFieldValue('time_range');
    if (weekday && range && range[0] && range[1]) {
      setPreview({ dates: buildPreviewDates(weekday), range });
    } else {
      setPreview({ dates: [], range: null });
    }
  };

  const handleSubmit = async (values: any) => {
    const [start, end] = values.time_range as [Dayjs, Dayjs];
    if (!start.isBefore(end)) {
      message.error('服务时段开始时间需早于结束时间');
      return;
    }
    setLoading(true);
    try {
      await recurringApi.create({
        elderly_id: values.elderly_id,
        worker_id: values.worker_id,
        weekday: values.weekday,
        start_time_str: start.format('HH:mm'),
        end_time_str: end.format('HH:mm'),
        title: values.title,
        description: values.description,
        care_type: values.care_type,
        address: values.address,
        duration_hours: end.diff(start, 'hour', true).toFixed(2),
        price: values.price,
      });
      message.success('常护安排成功，已生成未来四周订单');
      form.resetFields();
      setPreview({ dates: [], range: null });
      fetchData();
    } catch (error: any) {
      const data = error.response?.data;
      if (data?.conflict_weeks) {
        const detail = data.conflict_weeks
          .map((c: any) => `第${c.week}周(${c.date})`)
          .join('、');
        Modal.error({
          title: '时段冲突，本次安排未保存',
          content: `护工在以下周次已有未结束订单：${detail}。请调整星期或时段后重新提交，其余安排未受影响。`,
        });
      } else {
        message.error(data?.message || '提交失败');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCancelWeek = (need: any) => {
    Modal.confirm({
      title: `取消第${need.week_index}周服务`,
      content: `仅取消 ${dayjs(need.start_time).format('YYYY-MM-DD')} 这一时段，其余周次不受影响。确定取消吗？`,
      okText: '取消该周',
      okButtonProps: { danger: true },
      cancelText: '再想想',
      onOk: async () => {
        try {
          await careNeedsApi.cancel(need.id);
          message.success(`已取消第${need.week_index}周服务，该时段已释放`);
          fetchData();
        } catch (error: any) {
          message.error(error.response?.data?.message || '取消失败');
        }
      },
    });
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">常护安排</h1>

      <Card
        title={
          <Space>
            <CalendarOutlined />
            <span>新建常护安排</span>
          </Space>
        }
        className="max-w-3xl mb-8"
      >
        <Alert
          type="info"
          showIcon
          className="mb-6"
          message="选择老人、护工、每周星期和时段后，系统将一次性生成未来四周的订单；护工可在排班页逐周开始、完成。"
        />
        {workers.length === 0 && (
          <Alert
            type="warning"
            showIcon
            className="mb-6"
            message="您还没有收藏的护工"
            description={
              <span>
                常护安排需要指定护工，请先到
                <a onClick={() => navigate('/favorites')}> 收藏护工 </a>
                页面收藏，再回来安排。
              </span>
            }
          />
        )}

        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          initialValues={{
            price: 80,
            worker_id: presetWorkerId,
          }}
          onValuesChange={updatePreview}
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="elderly_id"
                label="选择老人"
                rules={[{ required: true, message: '请选择服务对象' }]}
              >
                <Select placeholder="请选择老人">
                  {elderlyList.map((elderly) => (
                    <Option key={elderly.id} value={elderly.id}>
                      {elderly.name}（{elderly.gender}，{elderly.age}岁）
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="worker_id"
                label="选择护工"
                rules={[{ required: true, message: '请选择护工' }]}
              >
                <Select placeholder="请选择护工（来自收藏列表）">
                  {workers.map((w) => (
                    <Option key={w.worker_id} value={w.worker_id}>
                      {w.real_name}（评分 {Number(w.rating).toFixed(1)}，已完成 {w.order_count} 单）
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="weekday"
                label="每周星期"
                rules={[{ required: true, message: '请选择每周星期' }]}
              >
                <Select placeholder="请选择">
                  {weekdayOptions.map((w) => (
                    <Option key={w.value} value={w.value}>
                      {w.label}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="time_range"
                label="服务时段"
                rules={[{ required: true, message: '请选择服务时段' }]}
              >
                <TimePicker.RangePicker
                  format="HH:mm"
                  minuteStep={30}
                  style={{ width: '100%' }}
                  placeholder={['开始时间', '结束时间']}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="price"
                label="单次价格(元)"
                rules={[{ required: true, message: '请输入价格' }]}
              >
                <InputNumber style={{ width: '100%' }} min={0} step={10} />
              </Form.Item>
            </Col>
          </Row>

          {preview.dates.length > 0 && preview.range && (
            <Alert
              type="success"
              showIcon
              className="mb-4"
              message={`将生成 ${preview.dates.length} 周订单，时段 ${preview.range[0].format(
                'HH:mm'
              )} - ${preview.range[1].format('HH:mm')}`}
              description={
                <div className="flex flex-wrap gap-2 mt-1">
                  {preview.dates.map((d, i) => (
                    <Tag key={i} color="green">
                      第{i + 1}周 {d.format('MM月DD日 ddd')}
                    </Tag>
                  ))}
                </div>
              }
            />
          )}

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="title"
                label="服务标题"
                rules={[{ required: true, message: '请输入服务标题' }]}
              >
                <Input placeholder="例如：每周上门康复护理" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="care_type"
                label="服务类型"
                rules={[{ required: true, message: '请选择服务类型' }]}
              >
                <Select placeholder="请选择服务类型">
                  {careTypes.map((t) => (
                    <Option key={t.value} value={t.value}>
                      {t.label}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            name="description"
            label="服务描述"
            rules={[{ required: true, message: '请输入服务描述' }]}
          >
            <TextArea rows={3} placeholder="请描述每次服务的内容、老人注意事项等" />
          </Form.Item>

          <Form.Item
            name="address"
            label="服务地址"
            rules={[{ required: true, message: '请输入服务地址' }]}
          >
            <Input placeholder="请输入详细的服务地址" />
          </Form.Item>

          <Form.Item className="mb-0">
            <div className="flex justify-end space-x-3">
              <Button onClick={() => navigate('/')}>取消</Button>
              <Button type="primary" htmlType="submit" loading={loading}>
                生成未来四周订单
              </Button>
            </div>
          </Form.Item>
        </Form>
      </Card>

      <h2 className="text-xl font-bold text-gray-800 mb-4">我的常护安排</h2>
      {arrangements.length === 0 ? (
        <Card>
          <Empty description="暂无常护安排" />
        </Card>
      ) : (
        <List
          dataSource={arrangements}
          renderItem={(item) => (
            <Card className="mb-4">
              <div className="flex justify-between items-start mb-3">
                <div>
                  <span className="text-lg font-medium">{item.title}</span>
                  <Tag color="blue" className="ml-2">
                    {careTypeMap[item.care_type] || item.care_type}
                  </Tag>
                </div>
                <div className="text-sm text-gray-500">
                  {weekdayOptions.find((w) => w.value === Number(item.weekday))?.label} {item.start_time_str}-
                  {item.end_time_str} · 护工 {item.worker_name}
                </div>
              </div>
              <div className="text-sm text-gray-500 mb-3">
                老人：{item.elderly_name} · 地址：{item.address} · 单次 ¥{item.price}
              </div>
              <List
                size="small"
                dataSource={item.needs}
                renderItem={(need: any) => (
                  <List.Item
                    actions={
                      ['pending', 'accepted'].includes(need.status)
                        ? [
                            <Button
                              key="cancel"
                              type="link"
                              danger
                              size="small"
                              onClick={() => handleCancelWeek(need)}
                            >
                              取消该周
                            </Button>,
                          ]
                        : []
                    }
                  >
                    <Space>
                      <Tag color="purple">第{need.week_index}周</Tag>
                      <span>{dayjs(need.start_time).format('YYYY-MM-DD ddd HH:mm')}</span>
                      <Tag color={statusMap[need.status]?.color}>{statusMap[need.status]?.label}</Tag>
                    </Space>
                  </List.Item>
                )}
              />
            </Card>
          )}
        />
      )}
    </div>
  );
};

export default RecurringCare;
