// Local mock-provider scenarios, shared by creation and task details.
export const scenarioLabels: Record<string, string> = {
  normal: "正常生成",
  accept_timeout: "已接单，但响应丢失",
  unknown_no_lookup: "响应丢失，且供应商不支持查单",
  rate_limit: "首次提交被限流",
  download_once: "生成成功，首次保存失败",
  provider_fail: "供应商确认生成失败",
};
