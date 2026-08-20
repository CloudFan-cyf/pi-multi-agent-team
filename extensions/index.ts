/**
 * pi-multi-agent-team — 多 Agent 协作团队激活与管理命令
 *
 * /team         激活协作模式：切换主会话到领导者模型并加载编排协议 skill
 * /team-models  为每个角色选择本机可用的模型提供方（写入 agentOverrides）
 * /team-doctor  迁移/环境体检：模型、agent、工具逐项检查
 *
 * 依赖：pi-subagents（subagent 工具与 agent 定义加载）。
 * 角色定义见本包 agents/ 目录，编排协议见 skills/team-orchestration/。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** 领导者配置文件（跨机器可改 leaderModel） */
const TEAM_CONFIG_PATH = join(homedir(), ".pi", "agent", "team.config.json");

const USER_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

interface RoleDef {
  /** 展示名 */
  label: string;
  /** pi-subagents agent 名（leader 为空 = 主会话） */
  agent?: string;
  /** 基础模型 id（不含 provider 前缀） */
  baseModelId: string;
  /** 默认 provider */
  defaultProvider: string;
}

const ROLES: RoleDef[] = [
  { label: "领导者 Leader（主会话）", baseModelId: "gpt-5.6-sol", defaultProvider: "openai-codex" },
  { label: "深度研究员 deep-researcher", agent: "deep-researcher", baseModelId: "deepseek-v4-pro", defaultProvider: "deepseek" },
  { label: "设计挑战者 challenger", agent: "challenger", baseModelId: "deepseek-v4-pro", defaultProvider: "deepseek" },
  { label: "执行者 executor", agent: "executor", baseModelId: "deepseek-v4-flash", defaultProvider: "deepseek" },
];

const AUTO = "__auto__";

// ---------- 工具函数 ----------

function readJsonSafe(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 解析领导者模型：返回 spec 与是否为用户显式配置（team.config.json） */
function resolveLeaderSpecInfo(): { spec: string; isOverride: boolean } {
  const cfg = readJsonSafe(TEAM_CONFIG_PATH);
  const m = cfg["leaderModel"];
  if (typeof m === "string" && m.includes("/")) return { spec: m, isOverride: true };
  return { spec: "openai-codex/gpt-5.6-sol", isOverride: false };
}

function resolveLeaderSpec(): string {
  return resolveLeaderSpecInfo().spec;
}

/** 剥离 provider/model[:thinking] 末尾的 thinking 后缀 */
function stripThinking(spec: string): string {
  return spec.replace(/:[a-z]+$/, "");
}

/** 解析 "provider/modelId[:thinking]" 形式（也接受裸 id：跨 provider 唯一匹配） */
function findModel(ctx: ExtensionContext, spec: string) {
  const base = stripThinking(spec);
  if (base.includes("/")) {
    const [provider, modelId] = base.split("/");
    return ctx.modelRegistry.find(provider, modelId);
  }
  const matches = ctx.modelRegistry.getAvailable().filter((m) => m.id === base);
  return matches.length === 1 ? matches[0] : undefined;
}

/** 枚举某基础模型 id 在本机可用的所有 provider 变体 */
function findVariants(ctx: ExtensionContext, baseModelId: string) {
  return ctx.modelRegistry
    .getAvailable()
    .filter((m) => m.id === baseModelId)
    .map((m) => ({ model: m, spec: `${m.provider}/${m.id}` }));
}

/** 全量可用模型目录（按 provider/model 排序） */
function fullCatalog(ctx: ExtensionContext) {
  return ctx.modelRegistry
    .getAvailable()
    .map((m) => ({ model: m, spec: `${m.provider}/${m.id}` }))
    .sort((a, b) => a.spec.localeCompare(b.spec));
}

/** 角色默认模型 spec（包内基准档位） */
function roleDefaultSpec(role: RoleDef): string {
  return `${role.defaultProvider}/${role.baseModelId}`;
}

/**
 * 确保三个子 agent 的模型 override 已物化。
 * 包内 agent frontmatter 不声明 model（以便用户 override 始终生效），
 * 因此默认档位必须在首次运行 team 命令时写入 settings 作为 override；
 * 缺失时 agent 会继承会话模型，不符合角色分工。
 */
function ensureDefaultsMaterialized(ctx: ExtensionContext): void {
  for (const role of ROLES) {
    if (!role.agent) continue;
    if (currentOverride(role.agent) === AUTO) {
      writeAgentOverride(role.agent, roleDefaultSpec(role));
    }
  }
  void ctx; // ctx 预留（未来按机器差异默认档）
}

/** 将 agentOverride.model 写入/清除用户 settings.json（JSON 安全合并） */
function writeAgentOverride(agent: string, modelSpec: string | null): void {
  const settings = readJsonSafe(USER_SETTINGS_PATH);
  const sub = (settings["subagents"] ??= {}) as Record<string, unknown>;
  const overrides = (sub["agentOverrides"] ??= {}) as Record<string, Record<string, unknown>>;
  if (modelSpec === null) {
    delete overrides[agent]?.["model"];
    if (overrides[agent] && Object.keys(overrides[agent]).length === 0) delete overrides[agent];
  } else {
    overrides[agent] = { ...(overrides[agent] ?? {}), model: modelSpec };
  }
  writeFileSync(USER_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

/** 当前生效的 override（agentOverrides 里配置的 model），无则返回 AUTO */
function currentOverride(agent: string): string {
  const settings = readJsonSafe(USER_SETTINGS_PATH);
  const sub = settings["subagents"] as Record<string, unknown> | undefined;
  const overrides = sub?.["agentOverrides"] as Record<string, Record<string, unknown>> | undefined;
  const model = overrides?.[agent]?.["model"];
  return typeof model === "string" ? model : AUTO;
}

function writeLeaderSpec(spec: string | null): void {
  const cfg = readJsonSafe(TEAM_CONFIG_PATH);
  if (spec === null) delete cfg["leaderModel"];
  else cfg["leaderModel"] = spec;
  writeFileSync(TEAM_CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

function report(ctx: ExtensionContext, message: string, kind: "info" | "error" | "success" = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, kind);
  } else {
    console.log(`[${kind}] ${message}`);
  }
}

// ---------- /team：激活协作模式 ----------

export default function (pi: ExtensionAPI) {
  pi.registerCommand("team", {
    description: "激活多 Agent 协作模式：切换主会话到领导者模型（GPT5.6 Sol）并加载 team-orchestration 编排协议",
    handler: async (_args, ctx) => {
      // 0. 物化子 agent 默认模型 override（首实现在任意 team 命令中完成）
      ensureDefaultsMaterialized(ctx);

      // 1. 解析并切换领导者模型
      const leaderSpec = resolveLeaderSpec();
      const leaderModel = findModel(ctx, leaderSpec);
      if (!leaderModel) {
        report(ctx, `未找到领导者模型 ${leaderSpec}。用 /team-models 检查或修改 ${TEAM_CONFIG_PATH} 的 leaderModel`, "error");
        return;
      }
      if (ctx.model?.id === leaderModel.id && ctx.model?.provider === leaderModel.provider) {
        report(ctx, `主会话已是领导者模型 ${leaderModel.provider}/${leaderModel.id}`, "info");
      } else {
        const ok = await pi.setModel(leaderModel);
        if (!ok) {
          report(ctx, `领导者模型 ${leaderModel.provider}/${leaderModel.id} 无可用 API key，激活中止`, "error");
          return;
        }
        report(ctx, `已切换到领导者模型 ${leaderModel.provider}/${leaderModel.id}`, "success");
      }

      // 2. 体检：subagent 工具（pi-subagents）
      const allTools = pi.getAllTools().map((t) => t.name);
      if (!allTools.includes("subagent")) {
        report(ctx, "未检测到 subagent 工具：本包依赖 pi-subagents。请先运行 pi install npm:pi-subagents 并重启 pi", "error");
        return;
      }

      // 3. 体检：web 工具（仅提示，不阻断——researcher 会降级）
      const hasWeb = ["web_search", "fetch_content"].every((t) => allTools.includes(t));
      if (!hasWeb) {
        report(ctx, "提示：web_search/fetch_content 不可用，deep-researcher 将无法做外部调研（可 pi install npm:pi-web-access）", "error");
      }

      // 4. 加载编排协议 skill（激活协作模式）
      await pi.sendUserMessage("/skill:team-orchestration", { deliverAs: "followUp", expandPromptTemplates: true });
      report(ctx, "协作模式激活：编排协议已作为 follow-up 加载", "success");
    },
  });

  // ---------- /team-models：角色模型选择 ----------

  pi.registerCommand("team-models", {
    description: "为团队各角色（领导者/研究员/挑战者/执行者）选择本机可用的任意模型；也可用参数形式 /team-models <agent> <provider/model|auto>；选「自动」恢复包内默认+fallback 链",
    handler: async (args, ctx) => {
      // 0. 物化子 agent 默认模型 override
      ensureDefaultsMaterialized(ctx);

      // ---- 参数形式：/team-models <agent> <spec|auto> ----
      const argParts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      if (argParts.length >= 2) {
        const [agentName, specArg] = argParts;
        const role = ROLES.find((r) => r.agent === agentName);
        if (!role?.agent) {
          report(
            ctx,
            `未知 agent「${agentName}」。可用：${ROLES.filter((r) => r.agent).map((r) => r.agent).join(", ")}`,
            "error",
          );
          return;
        }
        if (/^(auto|default)$/i.test(specArg)) {
          writeAgentOverride(role.agent, roleDefaultSpec(role));
          report(ctx, `${role.label} → 默认档位 ${roleDefaultSpec(role)}（+fallback 链）`, "success");
          return;
        }
        const spec = stripThinking(specArg);
        const model = findModel(ctx, spec);
        if (!model) {
          report(ctx, `模型 ${specArg} 不可用。运行 pi --list-models 查看可用模型，或 /team-models（无参数）交互选择`, "error");
          return;
        }
        writeAgentOverride(role.agent, spec);
        const authNote = ctx.modelRegistry.hasConfiguredAuth(model) ? "" : "（注意：无 API key）";
        report(ctx, `${role.label} → ${spec}${authNote}（重启 pi 或 /reload 后生效）`, "success");
        return;
      }

      // ---- 交互 / 打印形式 ----
      const catalog = fullCatalog(ctx);
      const lines: string[] = [];
      for (const role of ROLES) {
        const variants = findVariants(ctx, role.baseModelId);
        const current = role.agent ? currentOverride(role.agent) : resolveLeaderSpec();
        const currentLabel = current === AUTO
          ? `默认档位 ${roleDefaultSpec(role)}`
          : current;

        if (!ctx.hasUI) {
          lines.push(`${role.label}: 当前=${currentLabel}`);
          lines.push(`  可用模型: ${catalog.map((v) => v.spec).join(", ") || "无"}`);
          continue;
        }

        // 候选：默认档位（+fallback 链）→ 推荐变体（角色基础模型）→ 其余全部可用模型
        const recSpecs = new Set(variants.map((v) => v.spec));
        const others = catalog.filter((v) => !recSpecs.has(v.spec));
        const options = [
          role.agent
            ? `默认档位 ${roleDefaultSpec(role)}（+fallback 链）  [当前: ${currentLabel}]`
            : `自动（默认 openai-codex/gpt-5.6-sol）  [当前: ${currentLabel}]`,
          ...variants.map((v) =>
            `${v.spec}  推荐${ctx.modelRegistry.hasConfiguredAuth(v.model) ? "" : "  (无 API key)"}`,
          ),
          ...others.map((v) =>
            `${v.spec}${ctx.modelRegistry.hasConfiguredAuth(v.model) ? "" : "  (无 API key)"}`,
          ),
        ];
        const choice = await ctx.ui.select(`${role.label} — 选择模型`, options);
        if (choice === undefined) continue; // 用户取消，跳过该角色

        if (choice.startsWith("默认档位")) {
          writeAgentOverride(role.agent!, roleDefaultSpec(role));
          report(ctx, `${role.label} → 默认档位 ${roleDefaultSpec(role)}（+fallback 链）`, "success");
        } else if (choice.startsWith("自动")) {
          writeLeaderSpec(null);
          report(ctx, `${role.label} → 自动（默认 openai-codex/gpt-5.6-sol）`, "success");
        } else {
          const spec = stripThinking(choice.split("  ")[0].trim());
          if (role.agent) writeAgentOverride(role.agent, spec);
          else writeLeaderSpec(spec);
          report(ctx, `${role.label} → ${spec}（重启 pi 或 /reload 后完全生效）`, "success");
        }
      }
      if (!ctx.hasUI) {
        console.log(lines.join("\n"));
        console.log("无 UI 模式：用参数形式 /team-models <agent> <provider/model|auto> 直接设置");
      }
    },
  });

  // ---------- /team-doctor：体检 ----------

  pi.registerCommand("team-doctor", {
    description: "团队环境体检：逐角色检查模型可解析、API key 可用、agentOverrides 生效、依赖工具存在",
    handler: async (_args, ctx) => {
      // 0. 物化子 agent 默认模型 override
      ensureDefaultsMaterialized(ctx);

      const out: string[] = ["团队体检报告", "──────────"];
      let allOk = true;

      // 角色与模型
      for (const role of ROLES) {
        const override = role.agent ? currentOverride(role.agent) : null;
        const leaderInfo = role.agent ? null : resolveLeaderSpecInfo();
        const effective = role.agent
          ? (override === AUTO ? roleDefaultSpec(role) : override)
          : leaderInfo!.spec;
        const isDefault = role.agent
          ? effective === roleDefaultSpec(role)
          : !leaderInfo!.isOverride;
        const model = findModel(ctx, effective);
        if (!model) {
          allOk = false;
          out.push(`✗ ${role.label}: 模型 ${effective} 不可解析（${isDefault ? "默认" : "自定义"}）。运行 /team-models 重新选择`);
          continue;
        }
        const authOk = ctx.modelRegistry.hasConfiguredAuth(model);
        if (!authOk) allOk = false;
        out.push(
          `${authOk ? "✓" : "✗"} ${role.label}: ${model.provider}/${model.id}（${isDefault ? "默认" : "自定义"}）${authOk ? "" : " — 无可用 API key"}`,
        );
      }

      // 依赖工具
      out.push("──────────");
      const allTools = pi.getAllTools().map((t) => t.name);
      const hasSubagent = allTools.includes("subagent");
      const hasWeb = ["web_search", "fetch_content"].every((t) => allTools.includes(t));
      if (hasSubagent) out.push("✓ subagent 工具（pi-subagents）可用");
      else { allOk = false; out.push("✗ subagent 工具不可用：请 pi install npm:pi-subagents 并重启"); }
      if (hasWeb) out.push("✓ web 工具（pi-web-access）可用");
      else out.push("△ web 工具不可用：deep-researcher 将无法做外部调研（可 pi install npm:pi-web-access）");

      // skill 发现
      const systemPrompt = ctx.getSystemPrompt?.() ?? "";
      const skillFound = systemPrompt.includes("team-orchestration");
      out.push(skillFound ? "✓ team-orchestration skill 已被系统发现" : "△ team-orchestration skill 未出现在当前系统提示中（尚未激活属正常；/team 激活后生效）");

      out.push("──────────");
      out.push(allOk ? "结论：环境就绪，可运行 /team 激活协作模式" : "结论：存在 ✗ 项，请按提示修复");
      const text = out.join("\n");
      console.log(text);
      if (ctx.hasUI) report(ctx, allOk ? "体检完成：环境就绪（完整报告见终端日志）" : "体检完成：存在 ✗ 项（完整报告见终端日志）", allOk ? "success" : "error");
    },
  });
}
