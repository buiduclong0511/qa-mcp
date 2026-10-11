# Thiết kế test case

## Cách viết một case

1. Một case kiểm một mục tiêu. Tiêu đề nói rõ điều được kiểm: "Áp mã hết hạn báo lỗi", không viết "Test mã giảm giá".
2. `steps` là các hành động cụ thể user làm được, mỗi bước một hành động.
3. `expected` là thứ **quan sát được** trên màn hình (text, giá trị, trạng thái, điều hướng), không viết "hoạt động đúng".
4. `test_data` ghi giá trị cụ thể (mã, số tiền, chuỗi). Dữ liệu tạo mới đặt theo `test_data_rule` của dự án.
5. `preconditions` ghi trạng thái cần có trước (role đăng nhập, dữ liệu sẵn có).
6. `priority`:
   1. `high`: luồng chính, tiền/dữ liệu quan trọng, phân quyền, ảnh hưởng page khác.
   2. `medium`: edge case và luồng lỗi thường gặp.
   3. `low`: hiển thị, trường hợp hiếm.

## Kỹ thuật cần áp dụng

1. **Phân vùng tương đương:** chia input thành nhóm hợp lệ/không hợp lệ, mỗi nhóm một case đại diện.
2. **Giá trị biên:** min-1, min, max, max+1; rỗng; độ dài tối đa; 0, số âm, số thập phân; ngày đầu/cuối tháng, năm nhuận.
3. **Bảng quyết định:** nghiệp vụ có nhiều điều kiện kết hợp (VD: loại khách × loại mã × giá trị đơn) → mỗi tổ hợp có ý nghĩa một case.
4. **Chuyển trạng thái:** đối tượng có trạng thái (nháp → chờ duyệt → duyệt) → case cho chuyển hợp lệ và chuyển bị chặn.
5. **Đoán lỗi:** bấm nút 2 lần liên tiếp, refresh/back giữa luồng, mở 2 tab cùng sửa, mất mạng/timeout, ký tự đặc biệt `' " < > &`, emoji, tiếng Việt có dấu, khoảng trắng đầu/cuối, dán dữ liệu dài.
6. **Phân quyền:** mỗi role chính × hành động chính (xem/tạo/sửa/xoá); kiểm cả truy cập thẳng bằng URL khi không có quyền.
7. **Ảnh hưởng (type `impact`):** với mỗi page cũ liên quan, kiểm dữ liệu sau thay đổi hiển thị đúng ở:
   1. Danh sách/bảng chứa dữ liệu đó (thêm/sửa/xoá phản ánh đúng, filter/sort/tìm kiếm).
   2. Trang chi tiết và các tổng/đếm/báo cáo dùng dữ liệu đó.
   3. Luồng phía sau (VD: giỏ hàng → thanh toán → đơn hàng).
   4. Thông báo/lịch sử hoạt động nếu có.
8. **UI:** trạng thái loading/rỗng/lỗi, nút disabled khi đang xử lý, thông báo validation đúng vị trí, responsive (375px, 768px) khi nghiệp vụ dùng trên mobile.

## Không viết

1. Case trùng mục tiêu với case khác.
2. Case không kiểm được bằng giao diện (cần đọc DB, đọc log server) — ghi chú lại cho user thay vì tạo case.
3. Case kiểm hiệu năng/tải, bảo mật chuyên sâu — chỉ đề xuất nếu user yêu cầu.
