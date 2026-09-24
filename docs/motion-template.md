# 模板与生成数据结构（当前基线）

本轮只做管理员发布/管理模板，普通用户选模板生成。无 Train、投稿审核、模板恢复或旧静态模板回退。

| 对象 | 权威字段 / 关联 |
| --- | --- |
| templates | 标题、说明、分类、owner_id、status、current_version_id、preview_asset_id、更新时间 |
| template_versions | 不可变槽位 schema、Prompt、输出规格、version |
| template_version_assets | version_id + position + asset_id；动作参考有序，外键指向 assets |
| jobs | 固定 template_version_id；模板、输入、报价快照；独立执行和账务状态 |
| job_input_assets | 输入图片的 slot_key，以及参考视频的顺序；保证关系可以查询 |
| assets | 不可变文件身份、归属、用途、大小/哈希、状态、存储位置 |
| job_outputs | 任务生成资产的来源记录；任务历史不会永久占用输出文件 |
| creations | 已交付作品；独立 asset_id 和 deleted_at |

公开目录 `GET /api/templates` 返回槽位、规格与预览，不返回 `motionVideoIds` 和 `promptRecipe`；管理员目录接口返回完整配置。任务接口目前会把提交时的完整模板快照返回给任务所有者和有权查看任务的管理员，其中包含参考视频 ID、`promptRecipe` 和 `preset`。因此当前实现不承诺向生成用户隐藏模板 Prompt；获得参考视频 ID 也不等于拥有文件读取权限。

管理员更改参考视频、槽位、Prompt 或生成参数，创建新版本；更改标题/说明/分类或预览不创建生成版本。修改和删除要求 expectedUpdatedAt，防止并发覆盖。参考视频与预览资产分开，不能把人物图片当作参考视频，也不能把参考素材自动公开为预览。

状态：public 上架；private 下架；deleted 不可恢复删除。服务端允许管理员对下架模板报价和提交，但当前后台没有直接试用下架模板的入口；需要上架后从广场使用。删除禁止所有人新建任务，既有任务按已保存版本继续执行。旧版本只保留配置历史，无回滚承诺；后台详情只查询当前版本，没有历史版本列表或恢复接口。

API：

- GET /api/templates：公开目录。
- POST /api/admin/catalog-templates：幂等发布。
- GET /api/admin/catalog-templates：搜索/状态/分类/分页。
- GET /api/admin/catalog-templates/:id：详情。
- PATCH /api/admin/catalog-templates/:id：编辑、上下架。
- DELETE /api/admin/catalog-templates/:id：不可恢复删除。
- GET /api/admin/catalog-templates/:id/reference-videos/:videoId：管理员身份 + 该模板当前版本引用关系 + 资产 ready 校验；未按模板 deleted 状态拒绝，因此历史详情中的参考素材尚存时仍可读取。这不构成文件保留根，也不保证素材永远可读。
- GET /api/templates/:id/preview-video：公开模板匿名预览，非公开模板管理员读取；已删除拒绝。

任务提交在事务中验证最新模板版本、素材归属/用途/ready 状态、允许规格、余额和单用户未结束任务数量，再一次保存任务、输入关联、积分冻结与执行记录。全局供应商并发名额由 Worker 领取任务时控制，不在提交接口中分配。

报价由服务端重算。前端会提交 `expectedCost` 与 `priceVersion`，后端在字段存在时核对；当前 API 并未强制要求这两个字段，也没有必须先调用报价接口的凭证。相同幂等键且业务参数相同的重试返回原任务，即使模板后来修改或删除也不重复生成；参数不同返回 409。

当前预览只允许管理员独立上传，不支持把用户作品作为模板预览。业务若以后需要此功能，应新增显式引用和公开授权，不恢复 source_job_id 等间接文件定位链路。


## 当前参数与入口限制

- 动作参考：1–3 段，上传支持 MP4/MOV，每文件不超过 50 MiB；预览必须独立上传 MP4，每文件不超过 50 MiB。
- 图片槽位：服务端和编辑器支持 1–4 个必填槽位，类型为 person/scene；新增模板表单只提供单人物或双人物预设。
- 图片上传：JPG/PNG/WebP，文件上限 5 MiB、2500 万像素；重编码为 JPEG，最长边不超过 1920 像素。
- 可选时长为 4/8 秒，分辨率为 720p/1080p；模板可以限制为其子集。未实现 FPS、Seed、音频、增强等业务能力。
- 报价：720p 每 4 秒 12 积分，1080p 每 4 秒 24 积分；最终视频仍是固定样片，不随这些规格变化。
- 管理目录支持分页（默认每页 10，最多 100），公开目录一次返回所有上架模板。素材库每种用途最多返回最近 100 项，无翻页入口。
- `GET /api/admin/catalog-uploads` 查询当前管理员的参考/预览素材；`DELETE /api/assets/:id` 删除本人无占用的非输出素材。素材复用权限按所有者校验，不等同于所有管理员共享素材库。
- `GET /api/collection` 返回最多 100 条卡片，未结束任务优先；`totalCreations` 与 `activeTasks` 是全量计数。已删除作品不再进入该列表；失败和取消任务仍会显示。`GET /api/jobs` 保留任务历史，最多最近 100 条。
- `GET /api/creations` 返回最多 100 件可用作品；播放/下载使用 `GET /api/creations/:id/video`，删除使用 `DELETE /api/creations/:id`。作品文件读取仅限所有者，管理员身份不能越权读取。
