# BookHill 统一账户接入

## 状态与边界

2026-10-04：v2.3.0 的直接 Kanidm 登录暴露了 Google 按钮跳到账户页的问题：门户 Google 会话不能充当 Kanidm 原生会话。v2.3.1 配合 mltz-account v1.2.0，将 BookHill 改接门户 OIDC 桥接，完成门户登录及所需 TOTP 后再签发应用授权码。

BookHill 仍为静态网页。Kanidm 保存用户和原生凭据；账户门户负责 Google / TOTP 会话、BookHill OIDC 签发和 Google 绑定。稳定 `sub` 仍为 Kanidm UUID。Google Drive 保存学习数据。BookHill 服务器不新增学习数据数据库，也不保存 Google 或 IDM 令牌。

## 用户怎么使用

1. 点击「使用 MLTZ 账户登录」，前往账户中心的「登录 BookHill」页，选择 Google 或用户名 / Passkey。若启用了门户 TOTP，验证完成后自动返回 BookHill；已有有效门户会话时直接继续。
2. 返回 BookHill 即可使用本机学习功能。v2.3.2 在核实 Google 绑定后直接复制该 Google 身份的旧本机词表、课文、白板和句库，不用等云盘授权；旧副本保留。没有 Google 绑定时不能读取旧 Google 身份的数据、同步、导入或更新 Google 表格。
3. 用户菜单 →「管理账户 / 绑定 Google」，在账户中心确认并绑定自己的 Google 账户，然后返回 BookHill。
4. 点击页面上方「连接云盘并恢复数据」（用户菜单的连接按钮也可用），选择**同一个 Google 账户**并授予 `drive.file` 权限；未授权或选错账户会停止操作。账户中心的 Google 登录与 BookHill 的云盘授权是两步；前者完成不表示学习数据已下载。
5. 连接成功后同步词表、课文、白板、学习记录及设置，再同步句库。上方显示同步状态和英 / 西合计的词表、课文数量；句库文件失败会单独报错，不阻断词表和课文的恢复。词典安装包仍保存在本设备，需要另行安装。自动同步沿用原规则。刷新页面后重新点击统一账户登录（门户有会话时无需再次输入凭据），再连接云盘。应用令牌最长 15 分钟，不发 refresh token；过期时重新登录或授权。
6. 「退出统一账户」清除本页的两类令牌，并前往 IDM `/logout`。这不会撤销 Google 授权，也不会自动清掉其他应用的本地会话。

**身份边界：**此桥接只服务 BookHill，不伪造 Kanidm 会话或签名。直接接入 Kanidm `/oauth2/openid/<client>` 的其他应用仍需要原生凭据。其他服务应建立自己的客户端，不能复用 `bookhill` client 或令牌。Google 会话与 Kanidm 原生会话仍独立。

## 两套 Google 项目如何衔接

| 配置 | 用途 | 放在哪里 |
|---|---|---|
| IDM Google OAuth client ID / secret | 账户中心验证、绑定 Google 身份 | 账户中心服务端配置；secret 留在服务器 |
| BookHill 原 Google OAuth client ID | GIS 弹窗获取用户云盘访问授权 | `index.html` 的 `google-client-id`；公开的浏览器客户端 |
| BookHill 原 Picker API key | Google 表格文件选择器 | `index.html` 的 `google-api-key`；限制站点 Referer 和 Picker API |
| 门户 `bookhill` client ID | 登录统一账户，取得稳定 Kanidm `sub` | 公开客户端，无 client secret；只允许正式 BookHill 回调 |

**本次合并的是用户身份关系，保留两套 Google 客户端和 BookHill 原项目。**BookHill 不使用 IDM 的 Google secret，也不使用 IDM 的 Google token 去访问云盘。账户中心只返回已验证的 Google `sub`/邮箱，BookHill 再用自己获得的 Google token 请求 Google userinfo，比对 `sub`，确认后才启用 Drive/Sheets。

`drive.file` 的文件访问授权与应用相关。直接替换成另一个项目的客户端可能让旧文件不可见，Picker 的 App ID/Key 也必须匹配项目。若以后确实要迁到一个 Google Cloud 项目，应作为单独的云盘授权迁移：备份、配置同一项目内不同用途的 OAuth 客户端、重新同意授权、必要时通过 Picker 重新选取旧文件、验证能读写后再停用旧项目。不要仅替换 ID 或拼接两个 key。

参考：[Google GIS 令牌模型](https://developers.google.com/identity/oauth2/web/guides/use-token-model)、[Drive 权限范围](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)、[Kanidm 公开 OIDC 客户端](https://kanidm.github.io/kanidm/stable/integrations/oauth2.html#public-client-configuration)。

## 接口与校验

- Issuer：`https://idm.mltz.tech/auth/oidc/bookhill`
- Discovery：`https://idm.mltz.tech/auth/oidc/bookhill/.well-known/openid-configuration`
- Client：`bookhill`，**public**，无 secret；redirect 精确为 `https://lang.mltz.tech/`。
- Scopes：`openid email profile`，PKCE S256 必须启用；ES256 签名。
- OIDC 授权请求绑定发起浏览器的 host-only HttpOnly Cookie，最多保留 10 分钟；授权码只存 HMAC 哈希，60 秒失效，事务内只兑换一次。Access token 与已完成登录的门户 session 关联；退出、锁定、移出 `mltz_users` 或会话失效后，userinfo / 绑定查询拒绝该 token。ID token 不能调用这些接口。
- 门户独立 ES256 私钥加密保存在账户数据库 v5，重启保持不变；迁移必须一起保留数据库、`ACCOUNT_SECRET_KEY` 和公共域名。应用收到的 JWT 是门户签名，不能送到 Kanidm API 使用。
- 实现使用固定版本 `oauth4webapi` 3.8.8，验证 state、nonce、issuer、audience、过期、签名、userinfo 的 subject。单次登录请求的 state/nonce/verifier 暂存在 sessionStorage，10 分钟过期，回调立即移除 URL 参数并消费请求；访问令牌只保存在页面内存。
- Google scopes 保留 `openid email profile https://www.googleapis.com/auth/drive.file`；检查确实获得 `drive.file`，不扩大为全部 Drive 权限。

绑定查询：

```http
GET https://idm.mltz.tech/api/integrations/bookhill/google-link
Authorization: Bearer <BookHill 的门户 OIDC access_token>
Origin: https://lang.mltz.tech
```

已绑定返回：`{"sub":"<idm-sub>","google":{"sub":"<google-sub>","email":"<email>"}}`；未绑定为 `google:null`。401 表示登录无效或账户已禁用；403 为不允许的浏览器来源；502 为上游不可用。失败时不访问云盘。

接口验证门户 BookHill access token 的签名、issuer、audience、有效期和关联门户会话，重新核实 Kanidm 用户可用。过渡期兼容旧 BookHill Kanidm token，仍向原 userinfo 核实。不能用门户 Cookie、ID token、其他应用的 access token 或传入任意用户 ID 代替认证。只允许 `https://lang.mltz.tech` 的 CORS，不开 credentials、不设置 `.mltz.tech` Cookie、不返回 Google token/secret；响应 `no-store`。非浏览器调用可以省略 Origin，但仍必须带有效 bearer token。

每次 Drive/Sheets 请求前重新核实绑定。解绑、换绑、IDM 登录过期、选择了别人的 Google，均会停止后续请求。已发送到 Google 的单个请求无法事后撤回。

## 旧数据迁移与回退

- 新本机命名空间为 `idm:<Kanidm sub>`，不按邮箱或用户名识别人；离线 `local:<name>` 和 `guest` 保留。
- 登录后核实服务端 Google 绑定，即把同一 Google 的 `cloud:<Google sub>` 个人数据，以及 `cloud:<Google sub>` / 更早的 `google:<Google sub>` 句库复制到 `idm:<sub>`；不请求 Drive。保留 `updatedAt`、英语/西语分区、删除墓碑、Drive 文件 ID。v2.3.2 使用 v2 迁移标记，已有 v1 标记也会重新按较新记录合并，补齐先前遗漏的删除记录；不覆盖统一身份下较新的学习修改。旧本机副本不删除；仅本机 AI 密钥不复制、不上传，需在新身份下重新填写。
- 打开新身份时只读取默认设置，不创建比旧设置更新的记录；用户实际修改设置时才写入。这样旧学习语言等设置可正常迁移。已经由旧版本写入的设置仍遵守较新者优先，不强行覆盖。
- 本机存储失效或未保存成功，不标记迁移完成、不继续同步。
- 云盘目录和文件名保持 `langLSRW/langlsrw-userdata.json`、`langLSRW/libraries/*.tsv`。同步先读取并核对个人文档所属身份，匹配旧 Google 身份才接受云端数据，匹配当前 IDM/Google 对才接受后续同步；属于其他 IDM 的文档或损坏文档会停止同步，先处理备份，避免覆盖。本机写入不成功则停止上传；个人文档完成后才同步句库，句库失败显示部分成功状态。
- 文档新 identity 为 `{type:"idm",id:"<idm-sub>",googleSub:"<google-sub>",name:"…"}`。记录格式仍为 v2，不迁移更早的 `langlsrw-data.json`。
- 切换前备份 Google Drive 文件；回退时先停用新同步、导出当前学习数据并备份云盘，再恢复旧 BookHill 发布。旧代码不检查 IDM identity，不能新旧版本同时写同一云盘。账户中心接口是增量变更，可保留；`bookhill` 客户端可暂停其 scope-map 后恢复。
- 现有同步仍非多设备事务：整份文档上传存在并发覆盖风险，本次没有解决此原有限制。首次切换用单设备，确认备份后再打开其他设备。

## 上线顺序

1. 备份账户 SQLite 数据库，部署 `mltz-account v1.2.0`（增量迁移到 v5）。现有 nginx `/auth/`、`/api/` 已代理门户，不需要改其他服务。门户 `mltz-account` Kanidm client 保持原配置。
2. `bookhill` 桥接客户端的回调、来源、scope 在门户代码中严格固定；不用另设 secret。先验证新 discovery / JWKS 的公网 CORS。旧 Kanidm `bookhill` client 暂时保留，供已开始的原生登录及回退使用。
3. 测试 token POST、userinfo GET/Authorization 的 preflight。验证 Google → 所需 TOTP → BookHill 授权码，以及用户名 / Passkey → 门户 → BookHill 授权码。
4. 合并经审查的 BookHill 分支并按仓库 GitHub Release 流程发布；不要把应用代码放进 vps 仓库。
5. 用测试账户完成：OIDC 登录、未绑定拒绝同步、绑定后 Google 授权、选择错 Google 拒绝、旧数据读入、英语/西语词表新增/删除、另一设备读回、解绑后拒绝后续同步、退出及重新登录。

localhost 保持离线可用。生产绑定接口只允许正式站点；如需本地联调，应另建测试 IdP/测试绑定接口及独立客户端，不给生产接口放开任意 localhost CORS。

v5 回退注意：v1.1.0 会拒绝高于自身版本的数据库。不能只换回旧门户镜像；优先修复当前版本，或在确认之后用切换前备份恢复门户数据。BookHill 可单独回退到 v2.3.0，但 Google 登录仍有已知限制。不要丢弃切换后的用户资料或 Google 绑定。

## 验证

```sh
npm ci --ignore-scripts
node --test tests/*.test.js .agents/skills/*/scripts/*.test.js
node .agents/skills/langlsrw-traditional-grammar-analysis/scripts/build-web-prompt.js --check
```

新增测试用真实 ES256 签名/JWKS 模拟完整 OIDC 回调，拒绝错误 state、nonce、issuer、audience、过期、签名、userinfo subject；验证 Google 绑定和权限边界、跨语言旧记录复制及秘密排除。Google 真人授权和生产端到端验收必须在部署配套接口/客户端后完成。
