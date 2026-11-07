# Gate registry — FR-2.1

## Cơ sở và phạm vi

FR-2.1 được cung cấp trong bảng yêu cầu: ADM đăng ký cổng với nhà máy,
vị trí, chiều ra/vào và mã turnstile. Task bổ sung yêu cầu `edgeId`.
Comment ADR-9 trong schema hiện tại quy định một edge agent cho mỗi nhà máy.

Các quyết định bên dưới hoàn thiện những chi tiết mà đoạn spec này chưa quy
định. Report đầy đủ được liên kết trong README chưa truy cập được khi thực hiện
thay đổi; cần đối chiếu lại nếu nhóm có quy định khác.

Thay đổi hiện tại gồm schema, migration và kiểm tra ràng buộc database.
Các quy tắc ghi rõ “service/API” là hợp đồng cho bước triển khai CRUD tiếp theo,
chưa phải hành vi đã có của các route. Quét QR, điều khiển TCS và heartbeat thuộc
các chức năng riêng.

## Cấu trúc dữ liệu

### Edge

| Trường                          | Quy tắc                                                                       |
| :------------------------------ | :---------------------------------------------------------------------------- |
| `id`                            | ID cấu hình của edge agent; giữ kiểu string hiện có.                          |
| `name`                          | Tên hiển thị, bắt buộc.                                                       |
| `factoryId`                     | ID nhà máy, bắt buộc và duy nhất: mỗi nhà máy tối đa một edge trong registry. |
| `lastHeartbeatAt`, `lastSyncAt` | Giữ nguyên các trường hiện có.                                                |

### Gate

| Trường        | Quy tắc                                                                                            |
| :------------ | :------------------------------------------------------------------------------------------------- |
| `id`          | UUID do Prisma tạo mặc định; giữ nguyên ID của các bản ghi đã tồn tại. API không nhận thay đổi ID. |
| `name`        | Tên hiển thị, bắt buộc; không yêu cầu duy nhất.                                                    |
| `factoryId`   | ID nhà máy, bắt buộc.                                                                              |
| `edgeId`      | Edge đã tồn tại và thuộc đúng `factoryId`.                                                         |
| `location`    | Vị trí thực tế của cổng, bắt buộc.                                                                 |
| `direction`   | Enum `IN` hoặc `OUT`. Một bản ghi biểu diễn một chiều.                                             |
| `turnstileId` | Mã thiết bị được truyền cho `TurnstileClient.open()`, bắt buộc và duy nhất toàn registry.          |
| `active`      | Mặc định `true`; `false` nghĩa là ngừng sử dụng.                                                   |
| `createdAt`   | Thời điểm tạo, database mặc định thời gian hiện tại.                                               |
| `updatedAt`   | Prisma cập nhật khi ghi; câu SQL viết trực tiếp phải tự cập nhật trường này.                       |

Ví dụ đầu vào tạo cổng cho service/API sau này:

```json
{
  "name": "Cổng chính - lối vào",
  "factoryId": "binh-duong",
  "edgeId": "edge-bd",
  "location": "Cổng chính",
  "direction": "IN",
  "turnstileId": "turnstile-bd-01"
}
```

## Quy tắc và nơi thực thi

| Quy tắc                                                                                        | Nơi thực thi                                                                                                                                                                            |
| :--------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tất cả trường cấu hình là bắt buộc; ID, tên và vị trí không được chỉ chứa khoảng trắng.        | `NOT NULL` và các `CHECK` trong migration; service/API trim chuỗi và từ chối dữ liệu sai.                                                                                               |
| Một edge thuộc một nhà máy; mỗi nhà máy tối đa một edge.                                       | `Edge.factoryId` có unique index.                                                                                                                                                       |
| Gate phải thuộc cùng nhà máy với edge.                                                         | Khóa ngoại ghép `(edgeId, factoryId)` tham chiếu `Edge(id, factoryId)`. Áp dụng cho cả INSERT và UPDATE.                                                                                |
| Không xóa edge hoặc đổi ID/nhà máy của edge khi còn Gate tham chiếu, kể cả Gate ngừng sử dụng. | FK với `ON DELETE RESTRICT`, `ON UPDATE RESTRICT`.                                                                                                                                      |
| `factoryId` phải là đơn vị loại `FACTORY` có thật.                                             | Service/API qua public interface của module admin, khi `orgUnits()` được triển khai. Không thêm FK sang bảng của module admin.                                                          |
| Một thiết bị chỉ có một bản ghi Gate, kể cả bản ghi ngừng sử dụng.                             | Unique index trên `Gate.turnstileId`. Dựa trên adapter hiện có dùng một `TCS_BASE_URL`; nếu sau này có nhiều TCS namespace hoặc thiết bị hai chiều dùng chung ID, cần đổi thiết kế này. |
| Xóa cổng nghĩa là đặt `active = false`; lặp lại vẫn thành công.                                | Service/API; schema cung cấp cờ trạng thái, không tự chặn câu SQL DELETE trực tiếp. Không xóa sự kiện chấm công.                                                                        |
| Cổng ngừng sử dụng không được dùng cho lượt quét mới.                                          | Luồng scan/edge sau này phải kiểm tra `active`.                                                                                                                                         |
| ID và nhà máy của một Gate không thay đổi qua CRUD.                                            | Service/API; tránh đổi ý nghĩa lịch sử chấm công. Chuyển nhà máy thì ngừng sử dụng cổng cũ và đăng ký cổng/thiết bị phù hợp.                                                            |
| Có thể đổi `edgeId` sang edge cùng nhà máy; cấu hình mới chỉ ảnh hưởng lượt quét tương lai.    | Service/API và FK ghép. Với một edge/nhà máy hiện tại, thay máy vật lý có thể giữ nguyên ID logic của edge.                                                                             |
| ADM quản trị bằng quyền `gate:manage`; tài khoản có scope chỉ quản lý nhà máy trong scope.     | Service/API dùng public interface của IAM. Ghi audit khi thay đổi thành công.                                                                                                           |

`AttendanceEvent.gateId` vẫn là string, theo quy tắc module không tạo quan hệ
chéo. Giữ bản ghi Gate bằng cách ngừng sử dụng giúp tra cứu lịch sử; cấu hình
Gate không phải bản chụp vị trí/thiết bị tại thời điểm từng lượt quét.

## Migration và dữ liệu cũ

Migration `20261107000000_gate_registry` có transaction và kiểm tra trước khi
thay đổi. Nếu `Edge` hoặc `Gate` đã có dữ liệu, migration dừng và rollback:
schema cũ không chứa thông tin để suy ra đúng nhà máy, chiều và mã thiết bị.
Không tự gán nhà máy, không mặc định chiều và không xóa dữ liệu cũ.

Với database mới hoặc chưa có Edge/Gate, chạy từ thư mục gốc:

```sh
npm run db:up
# DATABASE_URL phải được cấu hình trong .env theo README.
(cd apps/server && npx prisma migrate deploy)
(cd apps/server && npx prisma generate)
```

Nếu có Edge/Gate cũ, cần chuẩn bị migration dữ liệu riêng trước khi triển khai:

1. Lập mapping `Edge.id -> factoryId` từ cấu hình nhà máy thực tế.
2. Lập mapping `Gate.id -> location, direction, turnstileId`; giữ nguyên ID.
3. Thêm các cột mới ở trạng thái nullable, nạp mapping và đối chiếu số bản ghi.
4. Kiểm tra trùng nhà máy/thiết bị và quan hệ Gate–Edge, rồi mới đặt `NOT NULL`,
   unique index và FK ghép tương đương migration này.
5. Nếu đã thử deploy và Prisma ghi nhận migration thất bại, xử lý trạng thái
   migration sau khi xác nhận transaction đã rollback; không dùng reset để bỏ dữ liệu.

Không sửa các migration đã được áp dụng. Kế hoạch dữ liệu cũ phải được hoàn thiện
trước lần áp dụng đầu tiên của migration này trên môi trường có Edge/Gate.

## Kiểm tra database

Sau khi áp dụng các migration trên database phát triển/test, có thể chạy bộ kiểm
tra SQL bằng PostgreSQL client. Dùng URL database test:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/server/prisma/tests/gate-registry.sql
```

Script kiểm tra dữ liệu hợp lệ, giá trị bắt buộc, enum, unique, FK ghép, cập nhật
chéo nhà máy và việc ngừng sử dụng giữ lịch sử. Các bản ghi kiểm tra nằm trong
transaction được rollback sau khi chạy.
