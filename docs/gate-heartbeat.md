# Gate heartbeat — FR-2.6

- `POST /api/edge/heartbeat` nhận contract `EdgeHeartbeat`, trả `204`, `400` nếu
  body sai hoặc `404` nếu edge không tồn tại. Lưu giờ server nhận, không dùng giờ
  edge; xác thực edge qua `EDGE_TOKENS` (#69) tại middleware gắn trên `/api/edge`.
- GET Gate trả thêm `status` và `lastHeartbeatAt`: không quá 90 giây là ONLINE,
  quá ngưỡng hoặc chưa có heartbeat là OFFLINE. Quyền/scope CRUD được giữ nguyên.
- Monitor kiểm tra mỗi 15 giây, gọi `Notifier.alert('GATE_OFFLINE', message)` một
  lần mỗi đợt mất kết nối của edge, liệt kê các cổng đang sử dụng bị ảnh hưởng.
- Edge chưa từng kết nối hoặc chỉ có cổng ngừng sử dụng không phát cảnh báo.
  Heartbeat mới cho phép cảnh báo ở đợt mất kết nối tiếp theo. Gửi lỗi sẽ thử lại.
- Chống lặp trong bộ nhớ của một server; restart có thể cảnh báo lại, nhiều
  server có thể cùng cảnh báo. Không thêm outbox, bảng dữ liệu hay migration.
- `ReportingService.alert()` hiện còn stub: việc gửi đến ADM thuộc module
  Reporting. Task này tích hợp interface sẵn có; lỗi notifier không bị bỏ qua.

Cấu hình `.env`: `EDGE_HEARTBEAT_TIMEOUT_MS=90000`, `EDGE_HEARTBEAT_CHECK_MS=15000`.
Edge agent gửi mỗi 30 giây theo hằng `HEARTBEAT_INTERVAL_MS` trong contract.

```json
{ "edgeId": "edge-bd", "sentAt": "2026-11-07T10:00:00+07:00", "snapshotAt": null, "outboxSize": 0 }
```

Chạy test: `npm test -w apps/server -- src/modules/gate`.
