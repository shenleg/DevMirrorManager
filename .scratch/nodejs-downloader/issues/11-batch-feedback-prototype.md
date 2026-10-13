# 批次结果与异常反馈的交互原型

Type: prototype
Labels: wayfinder:prototype
Status: open
Blocked by: 04, 06
Assignee: none

## Question

在 [搜索、多选与目标平台组合的交互模型](04-selection-interaction.md) 与 [下载任务的恢复、失败与完成语义](06-download-lifecycle.md) 确定后，如何向用户呈现批次进行中、取消、部分成功、失败、重试及可交付状态？

使用低保真原型决定哪些异常需要单独提示或阻断操作、何时需要用户介入，以及如何说明具体影响。至少覆盖：网络或校验失败、已有文件冲突、磁盘空间不足或目录不可用、索引生成/更新失败、镜像文件被外部修改，以及仍可用的部分内容。不得把原型变成正式应用实现；不要重新决定已由 [部分镜像的索引、校验文件与可用性承诺](05-partial-mirror-policy.md) 和 [下载任务的恢复、失败与完成语义](06-download-lifecycle.md) 锁定的内容规则。

加载 `prototype` 与 `domain-modeling`，由用户评估交互；不替用户判断原型是否清楚。
