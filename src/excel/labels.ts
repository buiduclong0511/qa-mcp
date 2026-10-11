export const RESULT_LABELS: Record<string, string> = {
  pending: "Chưa test",
  pass: "Pass",
  fail: "Fail",
  blocked: "Blocked",
  skipped: "Bỏ qua",
};

export const DEV_LABELS: Record<string, string> = {
  none: "Chưa xử lý",
  fixed: "Đã fix",
  not_bug: "Không phải bug",
};

export const TYPE_LABELS: Record<string, string> = {
  functional: "Chức năng",
  edge: "Edge case",
  negative: "Nhập sai / lỗi",
  permission: "Phân quyền",
  impact: "Ảnh hưởng page khác",
  ui: "Giao diện",
  other: "Khác",
};

export const PRIORITY_LABELS: Record<string, string> = {
  high: "Cao",
  medium: "Trung bình",
  low: "Thấp",
};

export function devStatusFromLabel(label: string): string | null {
  const normalized = label.trim().toLowerCase();
  if (normalized === "") return "none";
  for (const [key, value] of Object.entries(DEV_LABELS)) {
    if (value.toLowerCase() === normalized || key === normalized) return key;
  }
  return null;
}

export const META_SCHEMA = "qa-mcp-result";
export const META_VERSION = 1;
export const RESULT_SHEET = "Kết quả";
export const SUMMARY_SHEET = "Tổng hợp";
export const META_SHEET = "_meta";

export const COL = {
  code: "Mã TC",
  page: "Page",
  type: "Loại",
  priority: "Ưu tiên",
  title: "Tiêu đề",
  preconditions: "Điều kiện trước",
  steps: "Các bước",
  testData: "Dữ liệu test",
  expected: "Kết quả mong đợi",
  actual: "Kết quả thực tế",
  status: "Kết quả",
  bug: "Mã bug",
  image: "Ảnh",
  devStatus: "Trạng thái Dev",
  devNote: "Ghi chú Dev",
  caseId: "case_id",
  resultId: "result_id",
  runId: "run_id",
  // Dev values at export time: only cells the Dev actually changed are applied on import,
  // so an old file cannot overwrite a newer status set from chat.
  devStatusExported: "dev_status_exported",
  devNoteExported: "dev_note_exported",
} as const;

export const CASES_META_SCHEMA = "qa-mcp-cases";
export const CASES_SHEET = "Test case";

export const REVIEW_LABELS: Record<string, string> = {
  pending: "Chờ duyệt",
  approved: "Duyệt",
  rejected: "Không duyệt (chờ AI phản biện)",
  rebutted: "AI đã phản biện, chờ anh chọn lại",
  dropped: "Loại",
};

/** Values the user picks in the "Đánh giá" column. */
export const DECISION_APPROVE = "Duyệt";
export const DECISION_REJECT = "Không duyệt";

export const CASE_COL = {
  code: "Mã TC",
  page: "Page",
  type: "Loại",
  priority: "Ưu tiên",
  title: "Tiêu đề",
  preconditions: "Điều kiện trước",
  steps: "Các bước",
  testData: "Dữ liệu test",
  expected: "Kết quả mong đợi",
  current: "Trạng thái hiện tại",
  decision: "Đánh giá",
  reason: "Lý do",
  rebuttal: "Phản biện của AI",
  caseId: "case_id",
} as const;
