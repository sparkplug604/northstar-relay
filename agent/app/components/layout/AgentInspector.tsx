import { navigateWithAgentChatViewTransition } from "@agent-native/core/client/agent-chat";
import { useT } from "@agent-native/core/client/i18n";
import { focusAgentChat } from "@agent-native/toolkit/app/chat";
import { AgentChatSurface, AgentSidebar } from "@agent-native/toolkit/app/chat";
import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { chatThreadPath } from "@/lib/chat-paths";
import { TAB_ID } from "@/lib/tab-id";

import { RecoveryChatControls } from "./RecoveryChatControls";

const RECOVERY_MODELS = [{
  engine: "ai-sdk:ollama",
  label: "Local Ollama",
  models: ["qwen2.5:1.5b"],
  configured: true,
}];

interface AgentInspectorProps {
  children: ReactNode;
  chatHomeHandoffActive: boolean;
  chatHomeHandoffPending: boolean;
}

/** Contextual inspector shell used on secondary chat routes. */
export function AgentInspector({
  children,
  chatHomeHandoffActive,
  chatHomeHandoffPending,
}: AgentInspectorProps) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const embedded = new URLSearchParams(search).get("relay") === "1";
  const t = useT();

  const [embeddedChatOpen, setEmbeddedChatOpen] = useState(false);

  useEffect(() => {
    if (!embedded) return;
    const open = () => setEmbeddedChatOpen(true);
    window.addEventListener("agent-panel:open", open);
    return () => window.removeEventListener("agent-panel:open", open);
  }, [embedded]);

  if (embedded) {
    return <>
      {children}
      {embeddedChatOpen && (
        <aside className="recovery-embedded-chat" aria-label="Recovery agent chat">
          <AgentChatSurface
            mode="panel"
            chatOnly
            storageKey="relay-recovery-chat"
            browserTabId={TAB_ID}
            availableModels={RECOVERY_MODELS}
            showCollapseButton
            onCollapse={() => setEmbeddedChatOpen(false)}
            composerToolbarSlot={<RecoveryChatControls />}
          />
        </aside>
      )}
    </>;
  }

  function openAskAgentFullscreen(threadId?: string) {
    focusAgentChat();
    navigateWithAgentChatViewTransition(navigate, chatThreadPath(threadId));
  }

  return (
    <AgentSidebar
      position="right"
      chatViewTransition
      chatViewTransitionHandoff={chatHomeHandoffPending}
      storageKey="relay-recovery-chat"
      availableModels={RECOVERY_MODELS}
      composerToolbarSlot={pathname === "/home" ? <RecoveryChatControls /> : null}
      browserTabId={TAB_ID}
      openOnChatRunning={chatHomeHandoffActive}
      onFullscreenRequest={openAskAgentFullscreen}
      emptyStateText={t("chat.inspectEmptyState")}
      agentPageHref="/settings/agent"
      suggestions={[
        t("chat.inspectSuggestionCapabilities"),
        t("chat.inspectSuggestionHello"),
        t("chat.inspectSuggestionAction"),
      ]}
    >
      {children}
    </AgentSidebar>
  );
}
