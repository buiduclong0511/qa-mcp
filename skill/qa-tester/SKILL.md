---
name: qa-tester
description: Quy trình kiểm thử hộp đen website cho dự án bất kỳ (không phải Cogover), dữ liệu lưu qua MCP `qa-mcp` (SQLite). Dùng khi user gửi link website để onboard dự án test, đưa nghiệp vụ/page cần test, muốn lập và review test case, chạy test bằng Playwright, xem kết quả, xuất Excel, hoặc nạp lại file Excel kết quả để retest các case Dev đã fix. Task Cogover dùng $cogover-tester thay thế.
---

# QA Tester

Quy trình 9 bước: onboard dự án → nhận nghiệp vụ → tìm hiểu page → viết test case → user review → chạy test → báo kết quả → retest. Mọi dữ liệu đi qua tool `mcp__qa-mcp__*`. **Không có web UI/artifact**: review và kết quả trao đổi bằng file Excel trong Downloads, mọi lệnh của user đến qua prompt.

## Nguyên tắc bắt buộc

1. **Mọi thao tác trình duyệt dùng Playwright MCP** (`mcp__playwright__*`): tìm hiểu site và chạy test. Không dùng Claude in Chrome hay công cụ trình duyệt khác — user đã chỉ định Playwright cho skill này. Cửa sổ Playwright dùng profile riêng, lưu lại đăng nhập giữa các phiên.
2. **Quyền dữ liệu là giới hạn cứng.** Trước mọi thao tác trên site phải đọc `policy` từ `project_get`. Chưa có policy đã xác nhận thì chỉ được đọc/xem. Một case cần thao tác bị cấm (xoá, gửi thông báo, thanh toán…) → không thực hiện, ghi `blocked` kèm lý do.
3. **Không lưu và không gõ mật khẩu.** Cần đăng nhập thì nhờ user tự đăng nhập trên cửa sổ Playwright, rồi chờ user báo xong.
4. **Dialog trình duyệt** (alert/confirm/prompt): xử lý bằng `browser_handle_dialog`; chỉ chấp nhận dialog khi hành động đó nằm trong quyền đã cấp.
5. **Ảnh evidence chỉ lưu local** qua `evidence_attach`, không gửi đi đâu.
6. **Giữ RAM gọn:** chỉ giữ tab đang cần. Chạy test xong một lượt → đóng các tab test (`browser_tabs` với `action: "close"`). Kết thúc công việc hoặc user nói xong → `browser_close`. Playwright MCP tự đóng browser sau 60 phút không có lệnh nào.
7. **Không dựng web UI hay artifact** (không server tĩnh, không trang HTML). Trao đổi với user bằng chat và file Excel.
8. **Không lưu file ra thư mục làm việc:** chụp ảnh không truyền `filename` (file tự vào thư mục output chung của Playwright), rồi `evidence_attach` copy vào qa-mcp.
9. **Trả lời user ngắn gọn**, danh sách đánh số; không đổ log thô.

## Bước 0 — Đầu mỗi phiên

1. **Kiểm tra Playwright MCP:** không có tool `mcp__playwright__*` → báo user và **ngỏ ý cài hộ**:
   1. Cài hộ (user đồng ý): chạy `node <thư mục qa-mcp>/scripts/install.mjs` (đăng ký Playwright MCP bản ghim + profile/output dùng chung + idle-timeout, kèm lịch reaper và dọn rác), rồi báo user khởi động lại phiên Claude Code.
   2. User tự cài: đưa đúng lệnh trên. Không dùng `npx @playwright/mcp@latest` (mỗi bản mới lại phình cache).
   Chưa có Playwright thì dừng các bước cần trình duyệt.
2. Gọi `storage_check`.
3. Nếu `warn: true`: báo dung lượng `used_gb`/`limit_gb`, liệt kê `groups` theo dạng đánh số (ưu tiên nhóm `suggested`, ghi `reasons`, `size_mb`, `open_bugs`). Hỏi user chọn nhóm cần dọn. Nhóm có `open_bugs > 0` chỉ dọn khi user chọn đích danh.
4. User chọn xong → `evidence_cleanup(run_ids, confirm=false)` → báo tổng MB sẽ giải phóng → user đồng ý → `evidence_cleanup(confirm=true)`.
5. Nếu `playwright.warn: true` (rác Playwright vượt `warn_at_gb`): báo `total_gb` và từng phần (`profile_gb`, `output_gb`, `legacy_profiles_gb`, `npx_gb`), đề nghị chạy `cleanup_command --dry-run` để xem trước. User đồng ý thì chạy lệnh thật. Chỉ thêm `--purge-legacy-profiles` (mất đăng nhập ở profile cũ) hoặc `--prune-browsers` khi user đồng ý rõ.
6. Gọi `project_list` để biết dự án đã có.

## Bước 1 — Onboard dự án (user gửi link)

Nếu `project_list` đã có dự án trùng domain: `project_get`, tóm tắt lại 3–5 dòng, hỏi nghiệp vụ có thay đổi không → cập nhật bằng `project_upsert`/`pages_upsert`/`policy_set`, bỏ qua phần còn lại của bước 1.

Dự án mới:

1. Mở link bằng Playwright (`browser_navigate`). Chỉ đọc: `browser_snapshot`, `browser_navigate`, bấm menu/link điều hướng. Không bấm nút tạo/sửa/xoá/gửi.
2. Gặp trang đăng nhập → báo user: "Trang cần đăng nhập, anh đăng nhập trên cửa sổ Playwright giúp em rồi báo lại." Chờ user báo xong.
3. Lướt menu chính và các page chính, **chỉ ở mức tổng quan** (mỗi page 1 câu chức năng). Không đi sâu.
4. **Xin quyền dữ liệu** — hỏi user bằng text, đánh số, để user trả lời tự do:
   1. Được tạo dữ liệu mới không?
   2. Được sửa dữ liệu có sẵn không? Chỉ dữ liệu do test tạo hay cả dữ liệu khác?
   3. Được xoá không?
   4. Được thực hiện thao tác gửi email/SMS/thông báo tới người thật không?
   5. Được thao tác liên quan thanh toán không?
   6. Quy ước đánh dấu dữ liệu test? (đề xuất tiền tố `[QA]`)
   7. Có khu vực/page nào cấm đụng vào không?
5. Trình bày **tổng quan nghiệp vụ** ngắn (tối đa ~10 dòng: site làm gì, ai dùng, các page chính) để user xác nhận/sửa.
6. User xác nhận xong mới lưu:
   1. `project_upsert` (name, base_url, environment, login_note mô tả cách đăng nhập — không có mật khẩu, overview đã xác nhận).
   2. `policy_set` với `confirmed_by_user: true`, map đúng câu trả lời của user.
   3. `pages_upsert` các page chính (name, url, summary, roles, related_pages nếu đã thấy rõ liên quan).

## Bước 2–3 — Nhận nghiệp vụ cần test

User đưa nội dung nghiệp vụ và các page cần test. Đọc lại `project_get` (overview, policy, pages) trước khi làm tiếp. Chỗ nào nghiệp vụ mơ hồ → hỏi lại trước khi viết case (gộp câu hỏi, đánh số).

## Bước 4 — Tìm hiểu page mới và page bị ảnh hưởng

1. Page mới: mở bằng Playwright, tìm hiểu lại từ đầu (không dựa vào dữ liệu cũ): trường dữ liệu, nút, validation nhìn thấy, trạng thái, thông báo.
2. Page cũ có thể bị ảnh hưởng: lấy từ `related_page_ids` của page liên quan + tự suy luận (page dùng chung dữ liệu, danh sách/tổng hợp hiển thị dữ liệu đó, báo cáo, thông báo, phân quyền). Xem nhanh để biết điểm cần kiểm.
3. Lưu lại: `pages_upsert` (page mới + cập nhật `related_pages`), rồi `feature_create` (title, requirement gồm nghiệp vụ user đưa + phần đã làm rõ, page_ids gồm cả page bị ảnh hưởng).

## Bước 5 — Viết test case

Đọc [references/test-design.md](references/test-design.md) và áp dụng. Bắt buộc có:

1. Case chức năng chính (happy path).
2. Edge case: giá trị biên, rỗng, quá dài, ký tự đặc biệt/tiếng Việt có dấu, trùng lặp, số âm/0.
3. Case nhập sai/luồng lỗi.
4. Phân quyền theo role (nếu có nhiều role).
5. **Case `impact` cho từng page cũ bị ảnh hưởng.**
6. Case UI khi nghiệp vụ có hiển thị đáng kể.

Mỗi case cần kiểm tra được với policy hiện tại; case cần quyền bị cấm vẫn viết nhưng ghi rõ trong `preconditions` là "Cần quyền X — sẽ Blocked nếu không được cấp". Lưu bằng `cases_create` (gắn `page_id`).

## Bước 6 — User review test case bằng file Excel

1. `cases_export(feature_id)` → file `.xlsx` trong Downloads. Báo user ngắn gọn: đường dẫn file, số case, nhóm case, điểm còn chưa chắc. Hướng dẫn: điền cột **Đánh giá** (Duyệt / Không duyệt, ô vàng là case cần quyết định) và **Lý do** nếu không duyệt, rồi gửi lại đường dẫn file.
2. User gửi file → `cases_import(path)`:
   1. Có `issues` → báo dòng lỗi, hỏi user sửa file hoặc nạp phần hợp lệ (`allow_partial=true`).
   2. `review.need_rebuttal`: với từng case, cân nhắc lý do của user một cách khách quan.
      1. Lý do đúng (case thừa, trùng, ngoài phạm vi) → `case_rebut(concede=true)`.
      2. Còn lý do chuyên môn để giữ → `case_rebut(rebuttal=...)` ngắn gọn, cụ thể.
      3. User góp ý sửa nội dung case → `case_update`; thiếu case → `cases_create`.
3. Còn case phản biện hoặc có chỉnh sửa → `cases_export` lại (cột **Phản biện của AI** đã có nội dung; case chờ chọn lại để trống ô Đánh giá: Duyệt = giữ case, Không duyệt = loại) và gửi đường dẫn file mới. Lặp đến khi user ưng ý.
4. **Chỉ chạy test khi user ra lệnh trong prompt** ("bắt đầu test"…). Lúc đó lấy các case đang `approved` (`case_list(review_status="approved")`), báo số case sẽ chạy và số case bị bỏ qua.

## Bước 7 — Chạy test bằng Playwright MCP

Chỉ bắt đầu khi user ra lệnh trong prompt.

1. `run_create(project, kind="initial", feature_id)` (lấy các case đang `approved`).
2. Gặp trang đăng nhập → nhờ user đăng nhập trên cửa sổ Playwright rồi báo lại.
3. Với từng case trong `results` (theo thứ tự ưu tiên high → low):
   1. Kiểm policy; vi phạm → `result_record(status="blocked", actual="Cần quyền ... chưa được cấp")`, sang case kế.
   2. Thực hiện các bước bằng `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_wait_for`… Dữ liệu tạo mới phải theo `test_data_rule`.
   3. So kết quả thực tế với `expected`.
   4. Evidence:
      1. **Fail:** `browser_take_screenshot(fullPage=true, scale="css")` ngay tại bước lỗi → lấy đường dẫn file trong kết quả tool → `evidence_attach(kind="screenshot", source_path, step_no, caption)`. Thêm `browser_console_messages` (và `browser_network_requests` nếu lỗi API) → `evidence_attach(kind="console"/"network", content=...)` chỉ phần liên quan.
      2. **Pass:** nếu `project.capture_pass_screenshot = 1` thì chụp 1 ảnh màn hình cuối (không cần fullPage).
   5. `result_record` (status, actual mô tả ngắn điều thấy được, console_errors nếu có).
   6. Case không thực hiện được vì môi trường (site lỗi, thiếu dữ liệu) → `blocked` kèm lý do; không đoán kết quả.
4. Xong hết → `run_finish`, đóng các tab đã dùng để test.

## Bước 8 — Báo kết quả

1. `excel_export(run_id)` → file `.xlsx` kết quả trong Downloads (ảnh nhúng sẵn, cột "Trạng thái Dev" có dropdown cho Dev điền).
2. Báo trong chat: Pass/Fail/Blocked, danh sách case Fail (mã, tiêu đề, 1 dòng lỗi), đường dẫn file Excel.

## Bước 9 — Retest

1. User gửi đường dẫn file Excel kết quả Dev đã cập nhật:
   1. `excel_import(path, dry_run=true)` → báo: số dòng hợp lệ, số case "Đã fix", `issues`, `warnings`.
   2. Có `issues` → hỏi user: sửa file, hoặc chỉ nạp phần hợp lệ (`allow_partial=true`).
   3. User đồng ý → `excel_import(path)` → nhận `retest_run_id`.
2. User báo trạng thái Dev qua chat (không gửi file) → lấy `result_id` của từng case qua `run_get(run_id)`, gọi `dev_status_set(result_id, ...)`, rồi `run_create(project, kind="retest", parent_run_id)`.
3. Chạy lại như bước 7 cho lượt retest (chỉ các case Dev đã fix), rồi bước 8.

## Khi nghiệp vụ dự án thay đổi

Cập nhật bằng `project_upsert` (overview), `pages_upsert`, `feature_update`, `policy_set`; mọi thay đổi tự ghi vào bảng history. Case cũ không còn đúng → `case_update`.
