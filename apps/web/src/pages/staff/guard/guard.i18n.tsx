import { createContext, useContext } from 'react';

export type GuardLanguage = 'vi' | 'en';
export const GuardLanguageContext = createContext<GuardLanguage>('en');

const vi: Record<string, string> = {
  'Gate control': 'Điều khiển cổng',
  'Quick reasons': 'Lý do chọn nhanh',
  'QR expired': 'Mã QR hết hạn',
  'No phone': 'Không mang điện thoại',
  'Scanner unavailable': 'Không quét được mã',
  Other: 'Khác',
  Close: 'Đóng',
  Factory: 'Nhà máy',
  'View details': 'Xem chi tiết',
  'Search loaded events': 'Tìm trong các lượt đã tải',
  'Employee code, name or event ID': 'Mã NV, tên hoặc mã sự kiện',
  'Confirm manual override': 'Xác nhận mở cổng thủ công',
  'Your identity and reason will be recorded in the audit log.':
    'Danh tính của bạn và lý do sẽ được lưu vào nhật ký kiểm toán.',

  'Guard console': 'Trang bảo vệ',
  'Access log & manual override': 'Nhật ký ra vào và mở cổng thủ công',
  'Staff home': 'Trang nhân sự',
  'Sign out': 'Đăng xuất',
  'Sign in to monitor gates': 'Đăng nhập bảo vệ',
  'Gate operations': 'Quản lý ra vào tại cổng',
  'Monitor access and assist employees when scanning is unavailable.':
    'Theo dõi lượt ra vào và hỗ trợ nhân viên khi không quét được mã.',
  'Guard account required': 'Dành cho tài khoản bảo vệ',
  'Access log': 'Nhật ký ra vào',
  'Access events': 'Lượt ra vào',
  'Manual override': 'Mở cổng thủ công',
  'No access events match these filters.': 'Không có lượt ra vào phù hợp bộ lọc.',
  'Newest events first · Vietnam time (UTC+7)': 'Mới nhất trước · Giờ Việt Nam (UTC+7)',
  Time: 'Thời gian',
  Employee: 'Nhân viên',
  'Gate / factory': 'Cổng / nhà máy',
  Method: 'Hình thức',
  Outcome: 'Kết quả',
  Details: 'Chi tiết',
  Unidentified: 'Chưa xác định',
  'Unknown factory': 'Chưa rõ nhà máy',
  'Denied:': 'Từ chối:',
  'Override:': 'Lý do:',
  'Guard:': 'Bảo vệ:',
  'Event:': 'Mã sự kiện:',
  'Privacy notice': 'Thông báo quyền riêng tư',
  'Loading notice…': 'Đang tải thông báo…',
  'I have read privacy notice v': 'Tôi đã đọc thông báo quyền riêng tư v',
  'Saving…': 'Đang lưu…',
  'Acknowledge and continue': 'Xác nhận và tiếp tục',
  'Reload notice': 'Tải lại thông báo',
  'Loading access log…': 'Đang tải nhật ký…',
  'Last updated:': 'Cập nhật lúc:',
  'Refreshes every 15 seconds': 'Tự cập nhật mỗi 15 giây',
  'Refresh log': 'Làm mới nhật ký',
  'The log is not up to date.': 'Nhật ký chưa được cập nhật.',
  'Showing the newest': 'Đang hiển thị',
  'events. Narrow the date range, gate or outcome to see other events.':
    'lượt mới nhất. Thu hẹp thời gian, cổng hoặc kết quả để xem các lượt khác.',
  'DENIED — the turnstile did not confirm opening. No attendance was granted.':
    'DENIED — Chưa xác nhận cổng đã mở. Không ghi nhận chấm công thành công.',
  'Admission recorded. No open command was sent.':
    'Đã ghi nhận lượt qua cổng. Không gửi lệnh mở cổng.',
  'GRANTED — the turnstile confirmed opening.': 'GRANTED — Đã xác nhận cổng mở.',
  'Outcome unknown. Do not repeat this override. Check the access log using the event ID and contact the operator if it remains pending or missing.':
    'Chưa xác định được kết quả. Không gửi lại yêu cầu này. Kiểm tra mã sự kiện trong nhật ký và liên hệ quản trị nếu vẫn đang chờ hoặc chưa có bản ghi.',
  'Your session has ended.': 'Phiên đăng nhập đã kết thúc.',
  'Choose an eligible gate and enter an employee ID and reason.':
    'Chọn cổng phù hợp, nhập ID nhân viên và lý do.',
  'Enter a valid past admission time in Vietnam time.':
    'Nhập thời gian qua cổng hợp lệ trong quá khứ, theo giờ Việt Nam.',
  'Edit admission details': 'Sửa thông tin',
  'Close override': 'Đóng',
  'Admission details': 'Thông tin lượt qua cổng',
  Gate: 'Cổng',
  'Choose a gate': 'Chọn cổng',
  ' · Inactive': ' · Ngừng hoạt động',
  'Employee ID': 'ID nhân viên',
  'Use the employee record ID supplied by HR after verifying the person’s identity.':
    'Xác minh danh tính và dùng ID hồ sơ nhân viên do HR cung cấp.',
  Reason: 'Lý do',
  Action: 'Thao tác',
  'Open gate now': 'Mở cổng ngay',
  'Record an earlier manual admission': 'Ghi nhận lượt đã qua cổng',
  'Admission time (Vietnam, UTC+7)': 'Thời gian qua cổng (Việt Nam, UTC+7)',
  'This sends an open command to the selected turnstile and records your identity and reason.':
    'Gửi lệnh mở cổng đã chọn và lưu danh tính bảo vệ cùng lý do.',
  'Use only for an admission already performed by hand. This records attendance without opening the gate.':
    'Chỉ dùng cho lượt đã được cho qua bằng tay. Ghi nhận chấm công, không mở cổng.',
  'I verified the employee and the selected gate.': 'Tôi đã xác minh nhân viên và cổng được chọn.',
  'Submitting…': 'Đang gửi…',
  'Confirm and open gate': 'Xác nhận mở cổng',
  'Record admission': 'Ghi nhận lượt qua',
  Cancel: 'Hủy',
  'Access is limited to the factories assigned to your account.':
    'Bạn chỉ được thao tác với các nhà máy được phân công.',
  'No gates are assigned to this account. Contact your administrator.':
    'Tài khoản chưa được phân công cổng. Vui lòng liên hệ quản trị.',
  'Gate status at page load': 'Trạng thái cổng khi tải trang',
  'Reload the page for current gate status. Events from offline edges may appear after synchronization.':
    'Tải lại trang để cập nhật trạng thái cổng. Lượt quét từ edge mất kết nối sẽ xuất hiện sau khi đồng bộ.',
  'From (Vietnam day)': 'Từ ngày (giờ Việt Nam)',
  'Through (Vietnam day)': 'Đến hết ngày (giờ Việt Nam)',
  'All assigned gates': 'Tất cả cổng được phân công',
  'All outcomes': 'Tất cả kết quả',
  'Apply filters': 'Áp dụng bộ lọc',
  'Choose a valid date range of at most 31 days.': 'Chọn khoảng thời gian hợp lệ, tối đa 31 ngày.',
  'Checking guard access…': 'Đang kiểm tra quyền bảo vệ…',
  Retry: 'Thử lại',
  Username: 'Tên đăng nhập',
  Password: 'Mật khẩu',
  'Authenticator code': 'Mã xác thực',
  Continue: 'Đăng nhập',
  'Enter your username and password.': 'Nhập tên đăng nhập và mật khẩu.',
  'Wrong username or password.': 'Tên đăng nhập hoặc mật khẩu không đúng.',
  'This account is locked for now. Try again later.':
    'Tài khoản tạm bị khóa. Vui lòng thử lại sau.',
  'Too many attempts. Wait a minute and try again.': 'Quá nhiều lần thử. Vui lòng chờ một phút.',
  'No connection. Try again.': 'Không có kết nối. Vui lòng thử lại.',
  'Sign-in failed. Try again.': 'Đăng nhập không thành công. Vui lòng thử lại.',
  'Two-factor sign-in is not set up for this account. Contact IT.':
    'Tài khoản chưa thiết lập xác thực hai bước. Vui lòng liên hệ IT.',
  'Wrong or expired code. Sign in again.': 'Mã không đúng hoặc hết hạn. Vui lòng đăng nhập lại.',
  'This account does not have guard access.': 'Tài khoản không có quyền bảo vệ.',
  'Review and acknowledge the privacy notice to continue.':
    'Đọc và xác nhận thông báo quyền riêng tư để tiếp tục.',
  'The service is unavailable. Try refreshing.': 'Dịch vụ chưa sẵn sàng. Vui lòng làm mới trang.',
  'Invalid response from the service. Try refreshing.':
    'Phản hồi không hợp lệ. Vui lòng làm mới trang.',
  'Could not connect. Check your connection and refresh.':
    'Không thể kết nối. Kiểm tra kết nối và làm mới trang.',
  'Could not acknowledge the notice. Check your connection.':
    'Chưa xác nhận được thông báo. Vui lòng kiểm tra kết nối.',
  'Not the current version': 'Thông báo đã thay đổi. Vui lòng tải lại bản mới nhất.',
  'Employee not found': 'Không tìm thấy nhân viên.',
  'Gate not found': 'Không tìm thấy cổng.',
  'Gate and employee must be active': 'Cổng và nhân viên phải đang hoạt động.',
  'Override refused.': 'Yêu cầu mở cổng bị từ chối.',
};

export const guardString = (text: string, language: GuardLanguage) =>
  language === 'vi' ? (vi[text] ?? text) : text;
export const useGuardString = () => {
  const language = useContext(GuardLanguageContext);
  return (text: string) => guardString(text, language);
};

/** Reserve both translations so language changes do not move controls or clear form state. */
export function GuardText({ text }: { text: string }) {
  const language = useContext(GuardLanguageContext);
  const translated = guardString(text, 'vi');
  if (translated === text) return <>{text}</>;
  return (
    <span
      className="guard-translated"
      lang={language}
      data-reserve={language === 'vi' ? text : translated}
    >
      <span>{language === 'vi' ? translated : text}</span>
    </span>
  );
}

export const guardText = (text: string) => <GuardText text={text} />;
