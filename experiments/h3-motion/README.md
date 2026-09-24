# H3 视频参考实验（归档）

这是早期的视频参考请求构造实验，不属于当前 demo 的模型适配器。当前业务实际使用 `server/provider.mjs` 中的本地模拟供应商。

这里保留的是当时的协议假设与请求编译逻辑，未证明真实服务支持这些字段或能产生预期动作。再次接入前需重新核对供应商文档；不能将实验单元测试视为 API 联调通过。

## 文件

- `compile.mjs`：实验请求编译与本地校验。
- `run.mjs`：默认只构造请求；显式 `--submit` 分支会调用外部服务并可能产生费用。
- `example.json`：含虚构媒体 URL 的配置示例，不能直接用于真实生成。
- `compile.test.mjs`：请求编译与校验测试，不访问供应商。
- `archive/prepared-manifest-2026-09-23.json`：原有 prepared 状态的实验产物，不是接单或生成成功凭证。

在项目根目录执行：

```sh
npm run test:experiments
node experiments/h3-motion/run.mjs experiments/h3-motion/example.json
```

默认输出到 `experiments/h3-motion/output/`，该目录已加入忽略列表。日常 `npm test` 仅运行业务测试；归档实验独立运行。
