# Gate registry — FR-2.1

## Cơ sở và phạm vi

FR-2.1 được cung cấp trong bảng yêu cầu: ADM đăng ký cổng với nhà máy,
vị trí, chiều ra/vào và mã turnstile. Task bổ sung yêu cầu `edgeId`.
Comment ADR-9 trong schema hiện tại quy định một edge agent cho mỗi nhà máy.

Các quyết định bên dưới hoàn thiện những chi tiết mà đoạn spec này chưa quy
định. Report đầy đủ được liên kết trong README chưa truy cập được khi thực hiện
thay đổi; cần đối chiếu lại nếu nhóm có quy định khác.

Thay đổi hiện tại gồm schema, migration, Gate CRUD trong repo/service/API và
test. Quét QR và điều khiển TCS thuộc các chức năng riêng, hiện vẫn là stub.
Heartbeat và thông báo được mô tả trong [gate-heartbeat.md](gate-heartbeat.md).
Gate CRUD sử dụng cấu hình Edge đã được đăng ký trước.

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

Ví dụ đầu vào tạo cổng:

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

| Quy tắc                                                                                        | Nơi thực thi                                                                                                                                                                              |
| :--------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tất cả trường cấu hình là bắt buộc; ID, tên và vị trí không được chỉ chứa khoảng trắng.        | `NOT NULL` và các `CHECK` trong migration; service/API trim chuỗi và từ chối dữ liệu sai.                                                                                                 |
| Một edge thuộc một nhà máy; mỗi nhà máy tối đa một edge.                                       | `Edge.factoryId` có unique index.                                                                                                                                                         |
| Gate phải thuộc cùng nhà máy với edge.                                                         | Khóa ngoại ghép `(edgeId, factoryId)` tham chiếu `Edge(id, factoryId)`. Áp dụng cho cả INSERT và UPDATE.                                                                                  |
| Không xóa edge hoặc đổi ID/nhà máy của edge khi còn Gate tham chiếu, kể cả Gate ngừng sử dụng. | FK với `ON DELETE RESTRICT`, `ON UPDATE RESTRICT`.                                                                                                                                        |
| Gate phải dùng nhà máy của một Edge đã được đăng ký.                                           | Service kiểm tra `Edge.factoryId`; FK ghép tiếp tục bảo vệ lúc ghi. Đối chiếu đơn vị loại `FACTORY` qua module admin chưa được tích hợp ở Gate. Không gọi stub hoặc bỏ qua lỗi của admin. |
| Một thiết bị chỉ có một bản ghi Gate, kể cả bản ghi ngừng sử dụng.                             | Unique index trên `Gate.turnstileId`. Dựa trên adapter hiện có dùng một `TCS_BASE_URL`; nếu sau này có nhiều TCS namespace hoặc thiết bị hai chiều dùng chung ID, cần đổi thiết kế này.   |
| Xóa cổng nghĩa là đặt `active = false`; lặp lại vẫn thành công.                                | Service/API; schema cung cấp cờ trạng thái, không tự chặn câu SQL DELETE trực tiếp. Không xóa sự kiện chấm công.                                                                          |
| Cổng ngừng sử dụng không được dùng cho lượt quét mới.                                          | Luồng scan/edge sau này phải kiểm tra `active`.                                                                                                                                           |
| ID và nhà máy của một Gate không thay đổi qua CRUD.                                            | Service/API; tránh đổi ý nghĩa lịch sử chấm công. Chuyển nhà máy thì ngừng sử dụng cổng cũ và đăng ký cổng/thiết bị phù hợp.                                                              |
| Có thể đổi `edgeId` sang edge cùng nhà máy; cấu hình mới chỉ ảnh hưởng lượt quét tương lai.    | Service/API và FK ghép. Với một edge/nhà máy hiện tại, thay máy vật lý có thể giữ nguyên ID logic của edge.                                                                               |
| ADM quản trị bằng quyền `gate:manage`; tài khoản có scope chỉ quản lý nhà máy trong scope.     | Service/API dùng public interface của IAM. Ghi audit khi thay đổi thành công.                                                                                                             |

`AttendanceEvent.gateId` vẫn là string, theo quy tắc module không tạo quan hệ
chéo. Giữ bản ghi Gate bằng cách ngừng sử dụng giúp tra cứu lịch sử; cấu hình
Gate không phải bản chụp vị trí/thiết bị tại thời điểm từng lượt quét.

## HTTP API

Các route nằm dưới `/api`, nhận JSON và dùng `Authorization: Bearer <token>`
của phiên đã đăng nhập đầy đủ. ADM phải hoàn thành MFA trước khi gọi CRUD.

| Method   | Đường dẫn            | Quyền                         | Kết quả thành công                       |
| :------- | :------------------- | :---------------------------- | :--------------------------------------- |
| `POST`   | `/api/gates`         | ADM (`gate:manage`)           | `201`, JSON Gate và header `Location`.   |
| `GET`    | `/api/gates`         | ADM hoặc GRD (`gate:monitor`) | `200`, mảng Gate.                        |
| `GET`    | `/api/gates/:gateId` | ADM hoặc GRD                  | `200`, JSON Gate.                        |
| `PATCH`  | `/api/gates/:gateId` | ADM                           | `200`, JSON Gate đã cập nhật.            |
| `DELETE` | `/api/gates/:gateId` | ADM                           | `204`, ngừng sử dụng; lặp lại vẫn `204`. |

POST yêu cầu đủ sáu trường trong ví dụ JSON bên trên. ID, trạng thái và thời
gian do hệ thống quản lý. PATCH nhận một hoặc nhiều trường `name`, `edgeId`,
`location`, `direction`, `turnstileId`, hoặc `active: true` để khôi phục cổng đã
ngừng sử dụng. `active: false` không được nhận qua PATCH; dùng DELETE để ngừng
sử dụng. Cổng inactive chỉ được sửa khi request đồng thời có `active: true`,
nếu không trả `409`. Không nhận `factoryId`, `id`, timestamp hoặc trường ngoài
danh sách. Chuỗi được trim; body rỗng, array và sai kiểu/chiều bị từ chối.

GET danh sách hỗ trợ `factoryId`, `edgeId`, `active=true|false`; có thể kết hợp.
Mặc định trả cả cổng đang dùng và ngừng sử dụng. Muốn chỉ cổng đang dùng, truyền
`active=true`. Query sai kiểu, lặp tham số, rỗng hoặc không được hỗ trợ trả `400`.
Danh sách được sắp xếp theo tên, rồi ID.

ADM/GRD có scope chỉ thấy cổng thuộc các nhà máy trong scope. Không truyền
`factoryId` vẫn lọc tất cả nhà máy được phép; scope rỗng trả `[]`. Yêu cầu danh
sách với `factoryId` ngoài scope trả `403`. Đọc/sửa/xóa một cổng ngoài scope trả
`404` giống cổng không tồn tại; không tiết lộ sự tồn tại của bản ghi đó.

| Status | Trường hợp                                                                |
| :----- | :------------------------------------------------------------------------ |
| `400`  | Dữ liệu/query không hợp lệ, Edge không tồn tại hoặc thuộc nhà máy khác.   |
| `401`  | Chưa đăng nhập, phiên không hợp lệ hoặc chưa hoàn thành MFA.              |
| `403`  | Thiếu quyền hoặc yêu cầu tạo/lọc danh sách ngoài scope nhà máy.           |
| `404`  | Gate không tồn tại hoặc không thuộc scope được phép.                      |
| `409`  | `turnstileId` đã được đăng ký, hoặc sửa cổng inactive mà không khôi phục. |
| `500`  | Lỗi database hoặc audit; không chuyển thành phản hồi thành công.          |

Các thay đổi tạo/sửa/ngừng sử dụng ghi audit với actor của phiên, target
`gate:<id>`, action `GATE_CREATE`/`GATE_UPDATE`/`GATE_DEACTIVATE` và cấu hình
before/after. PATCH không làm thay đổi giá trị và DELETE lặp lại không thêm
audit. Khôi phục qua `active: true` ghi `GATE_UPDATE` với before/after của trạng
thái active. Hai yêu cầu DELETE đồng thời chỉ ghi một lần chuyển trạng thái.

Giới hạn hiện tại giống module employee-qr (#45): ghi Gate và append audit là
hai transaction riêng. Nếu audit lỗi sau khi Gate đã được ghi, API trả `500`
nhưng dữ liệu Gate có thể đã đổi; chưa có rollback chung hoặc khôi phục audit
qua retry. Snapshot before cũng chưa được khóa cùng mutation khi có PATCH
đồng thời. Cần transaction boundary dùng chung qua public interface các module
để bảo đảm tính nguyên tử, không đọc/ghi trực tiếp bảng IAM từ module gate.

## Thử API bằng Postman hoặc curl

Sau khi migrate, cần có Edge trước khi tạo Gate. Ví dụ dữ liệu local trong
PostgreSQL (đăng ký một lần; nhà máy phải đúng cấu hình thực tế):

```sql
INSERT INTO "Edge" ("id", "name", "factoryId")
VALUES ('edge-bd', 'Edge Bình Dương', 'binh-duong');
```

Chạy `npm run dev`. Dùng tài khoản ADM hiện có, hoặc tạo bằng script có sẵn
`npm run user:create -w apps/server -- --username <name> --password <password> --role ADM`.
Script tạo ADM cung cấp thông tin đăng ký TOTP. Đăng nhập qua
`POST /api/auth/login` với `username`, `password`, lấy `token`, rồi xác thực
`POST /api/auth/mfa` với header Bearer đó và body `{"code":"<TOTP>"}`.
Token giữ nguyên sau khi MFA thành công.

Trong Postman, đặt Bearer token và Content-Type `application/json`, dùng body
tạo cổng bên trên. Ví dụ curl, với `ADM_TOKEN` là token đã qua MFA:

```sh
curl -i http://localhost:3000/api/gates \
  -H "Authorization: Bearer $ADM_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Cổng chính","factoryId":"binh-duong","edgeId":"edge-bd","location":"Nhà bảo vệ","direction":"IN","turnstileId":"turnstile-bd-01"}'

curl 'http://localhost:3000/api/gates?factoryId=binh-duong&active=true' \
  -H "Authorization: Bearer $ADM_TOKEN"

# GATE_ID lấy từ JSON trả về khi tạo.
curl -X PATCH "http://localhost:3000/api/gates/$GATE_ID" \
  -H "Authorization: Bearer $ADM_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Cổng phía trước"}'

curl -i -X DELETE "http://localhost:3000/api/gates/$GATE_ID" \
  -H "Authorization: Bearer $ADM_TOKEN"
```

## Migration và dữ liệu cũ

Migration `20261107000000_gate_registry` có transaction và kiểm tra trước khi
thay đổi. Nếu `Edge` hoặc `Gate` đã có dữ liệu, migration dừng và rollback:
schema cũ không chứa thông tin để suy ra đúng nhà máy, chiều và mã thiết bị.
Không tự gán nhà máy, không mặc định chiều và không xóa dữ liệu cũ.

Repo không cấu hình Prisma seed và không có script seed/demo tự tạo Edge/Gate.
Các script tạo tài khoản/publish notice không ghi các bảng này; ví dụ đăng ký
Edge ở phần thử API phải chạy sau migration.

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

Test service/API và ánh xạ lỗi Prisma được chạy cùng bộ test hiện có:

```sh
npm test -w apps/server -- src/modules/gate
```
