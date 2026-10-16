import type { Comment, CommentReportReason } from "@niltv/types";
import { COMMENT_MAX_LENGTH } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";

import {
  useAcceptCommentTerms,
  useBlockUser,
  useComments,
  useDeleteComment,
  useEditComment,
  useMe,
  usePostComment,
  useReportComment,
} from "@/api/hooks";
import { useAuthStore, requireAuth } from "@/auth/store";
import { config } from "@/config";
import { Avatar } from "@/components/Avatar";
import { GoldButton } from "@/components/GoldButton";
import { Sheet } from "@/components/Sheet";
import {
  canSubmitComment,
  commentAge,
  guidelineLinks,
  isExplicitDraft,
  isTermsRequired,
  postErrorMessage,
} from "@/lib/comments";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

const REPORT_REASONS: { reason: CommentReportReason; label: string }[] = [
  { reason: "harassment", label: "Harassment or bullying" },
  { reason: "hate", label: "Hate speech" },
  { reason: "sexual", label: "Sexual content" },
  { reason: "violence", label: "Violence or threats" },
  { reason: "spam", label: "Spam" },
  { reason: "other", label: "Something else" },
];

type Panel =
  | { kind: "menu"; comment: Comment }
  | { kind: "own"; comment: Comment }
  | { kind: "report"; comment: Comment }
  | { kind: "terms" }
  | null;

const GUIDELINES = [
  "Be kind. No harassment, bullying, hate speech or threats.",
  "No sexual content, and no sharing personal details or links.",
  "Comments that break these rules are removed, and accounts that keep breaking them can lose commenting.",
  "You can report any comment and block any user. Our team reviews reports.",
];

/**
 * Comments for one clip, as a bottom sheet over the feed. Moderation surfaces
 * live here: every comment by someone else has a "…" menu with Report and Block,
 * and the composer states the guidelines. The server filters and holds
 * comments; this only renders what it returns.
 */
export function CommentsSheet({
  contentId,
  visible,
  onClose,
}: {
  contentId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const t = useTheme();
  const { height } = useWindowDimensions();
  const signedIn = useAuthStore((s) => s.status === "signedIn");
  const me = useMe();
  const comments = useComments(contentId, visible && signedIn);
  const post = usePostComment(contentId);
  const edit = useEditComment(contentId);
  const del = useDeleteComment(contentId);
  const acceptTerms = useAcceptCommentTerms();
  const report = useReportComment(contentId);
  const block = useBlockUser();

  const [editing, setEditing] = useState<Comment | null>(null);
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState<string | null>(null);

  const items = comments.data?.pages.flatMap((p) => p.comments) ?? [];

  function close() {
    setPanel(null);
    setError(null);
    setEditing(null);
    onClose();
  }

  // Guidelines and contact links, shown only once real values are configured.
  const links = guidelineLinks(config);
  function openLink(url: string) {
    Linking.openURL(url).catch(() => Alert.alert("Couldn't open the link", "Please try again later."));
  }

  const busy = post.isPending || edit.isPending;
  // Explicit text can't be sent: Send stays off and the composer says why.
  const explicit = isExplicitDraft(draft);

  function afterWrite(status: Comment["status"]) {
    setDraft("");
    setEditing(null);
    if (status === "pending") {
      Alert.alert("Awaiting review", "Your comment will appear once our team has reviewed it.");
    }
  }

  function submit() {
    if (!canSubmitComment(draft) || busy) return;
    setError(null);
    const body = draft.trim();
    if (editing) {
      edit.mutate(
        { commentId: editing.id, body },
        {
          onSuccess: (data) => afterWrite(data.comment.status),
          onError: (e) => setError(postErrorMessage(e)),
        },
      );
      return;
    }
    post.mutate(body, {
      onSuccess: (data) => afterWrite(data.comment.status),
      // First comment: the draft is kept while the guidelines are shown.
      onError: (e) => {
        if (__DEV__) {
          const err = e as { status?: unknown; code?: unknown; message?: unknown };
          console.warn("comment post failed", { apiBase: config.apiBase, status: err.status, code: err.code, message: err.message });
        }
        if (isTermsRequired(e)) setPanel({ kind: "terms" });
        else setError(postErrorMessage(e));
      },
    });
  }

  function agreeAndPost() {
    acceptTerms.mutate(undefined, {
      onSuccess: () => {
        setPanel(null);
        submit();
      },
      onError: () => Alert.alert("Something went wrong", "Please try again."),
    });
  }

  function confirmDelete(comment: Comment) {
    Alert.alert("Delete this comment?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          del.mutate(comment.id, {
            onSuccess: () => setPanel(null),
            onError: () => Alert.alert("Something went wrong", "That comment wasn't deleted. Please try again."),
          }),
      },
    ]);
  }

  function confirmBlock(comment: Comment) {
    Alert.alert(
      `Block ${comment.authorName}?`,
      "You won't see their comments any more. You can unblock them from your profile.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Block",
          style: "destructive",
          onPress: () =>
            block.mutate(comment.authorId, {
              onSuccess: () => setPanel(null),
              onError: () => Alert.alert("Something went wrong", "That user wasn't blocked. Please try again."),
            }),
        },
      ],
    );
  }

  function sendReport(comment: Comment, reason: CommentReportReason) {
    report.mutate(
      { commentId: comment.id, reason },
      {
        onSuccess: () => {
          setPanel(null);
          Alert.alert("Thanks for reporting", "We've hidden this comment from you and our team will review it.");
        },
        onError: () => Alert.alert("Something went wrong", "Your report wasn't sent. Please try again."),
      },
    );
  }

  const body = (() => {
    if (!signedIn) {
      return (
        <Text style={[styles.state, { color: t.subtext }]}>Sign in to read and join the conversation.</Text>
      );
    }
    if (panel?.kind === "terms") {
      return (
        <View style={styles.panel}>
          <Text style={[styles.panelTitle, { color: t.text }]}>Community guidelines</Text>
          {GUIDELINES.map((line) => (
            <Text key={line} style={[styles.guideline, { color: t.subtext }]}>
              • {line}
            </Text>
          ))}
          {links.map((link) => (
            <HelpLinkText key={link.url} label={link.label} onPress={() => openLink(link.url)} />
          ))}
          <GoldButton
            label={acceptTerms.isPending ? "Saving…" : "I agree"}
            onPress={agreeAndPost}
            style={styles.agree}
          />
          <MenuRow icon="close" label="Not now" onPress={() => setPanel(null)} />
        </View>
      );
    }
    if (panel?.kind === "own") {
      const c = panel.comment;
      return (
        <View style={styles.panel}>
          <Text style={[styles.panelTitle, { color: t.subtext }]} numberOfLines={2}>
            {c.body}
          </Text>
          <MenuRow
            icon="create-outline"
            label="Edit comment"
            onPress={() => {
              setEditing(c);
              setDraft(c.body);
              setError(null);
              setPanel(null);
            }}
          />
          <MenuRow icon="trash-outline" label="Delete comment" danger onPress={() => confirmDelete(c)} />
          <MenuRow icon="close" label="Cancel" onPress={() => setPanel(null)} />
        </View>
      );
    }
    if (panel?.kind === "menu") {
      const c = panel.comment;
      return (
        <View style={styles.panel}>
          <Text style={[styles.panelTitle, { color: t.subtext }]} numberOfLines={2}>
            {c.authorName}: {c.body}
          </Text>
          <MenuRow icon="flag-outline" label="Report comment" onPress={() => setPanel({ kind: "report", comment: c })} />
          <MenuRow icon="ban-outline" label={`Block ${c.authorName}`} danger onPress={() => confirmBlock(c)} />
          <MenuRow icon="close" label="Cancel" onPress={() => setPanel(null)} />
        </View>
      );
    }
    if (panel?.kind === "report") {
      const c = panel.comment;
      return (
        <View style={styles.panel}>
          <Text style={[styles.panelTitle, { color: t.text }]}>Why are you reporting this?</Text>
          {REPORT_REASONS.map(({ reason, label }) => (
            <MenuRow key={reason} icon="chevron-forward" label={label} onPress={() => sendReport(c, reason)} />
          ))}
          <MenuRow icon="arrow-back" label="Back" onPress={() => setPanel({ kind: "menu", comment: c })} />
        </View>
      );
    }
    return (
      <FlatList
        data={items}
        keyExtractor={(c) => c.id}
        keyboardShouldPersistTaps="handled"
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (comments.hasNextPage && !comments.isFetchingNextPage) void comments.fetchNextPage();
        }}
        renderItem={({ item }) => (
          <CommentRow
            comment={item}
            mine={item.authorId === me.data?.userId}
            onMenu={() =>
              requireAuth(() =>
                setPanel(
                  item.authorId === me.data?.userId
                    ? { kind: "own", comment: item }
                    : { kind: "menu", comment: item },
                ),
              )
            }
          />
        )}
        ListEmptyComponent={
          comments.isPending ? (
            <ActivityIndicator color={t.accent} style={styles.state} />
          ) : comments.isError ? (
            <Pressable onPress={() => void comments.refetch()} accessibilityRole="button" style={styles.state}>
              <Text style={{ color: t.subtext }}>Couldn&apos;t load comments. Tap to retry.</Text>
            </Pressable>
          ) : (
            <Text style={[styles.state, { color: t.subtext }]}>No comments yet. Be the first.</Text>
          )
        }
        ListFooterComponent={
          comments.isFetchingNextPage ? <ActivityIndicator color={t.accent} style={styles.state} /> : null
        }
      />
    );
  })();

  return (
    <Sheet visible={visible} onClose={close} title="Comments">
      <View style={{ height: Math.round(height * 0.5) }}>{body}</View>
      {panel === null ? (
        signedIn ? (
          <View>
            {editing ? (
              <View style={styles.editing}>
                <Text style={[styles.guidelines, { color: t.subtext }]}>Editing your comment</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel edit"
                  onPress={() => {
                    setEditing(null);
                    setDraft("");
                    setError(null);
                  }}
                >
                  <Text style={{ color: t.accent }}>Cancel</Text>
                </Pressable>
              </View>
            ) : null}
            {explicit ? (
              <Text style={styles.error} accessibilityLiveRegion="polite">
                That language isn&apos;t allowed in comments. Please change it to post.
              </Text>
            ) : error ? (
              <Text style={styles.error}>{error}</Text>
            ) : null}
            <View style={styles.composer}>
              <TextInput
                value={draft}
                onChangeText={(v) => {
                  setDraft(v);
                  if (error) setError(null);
                }}
                placeholder="Add a comment…"
                placeholderTextColor={t.subtext}
                maxLength={COMMENT_MAX_LENGTH}
                multiline
                accessibilityLabel="Add a comment"
                style={[styles.input, { color: t.text, backgroundColor: t.inset }]}
              />
              <Pressable
                onPress={submit}
                disabled={!canSubmitComment(draft) || busy}
                accessibilityRole="button"
                accessibilityLabel={editing ? "Save comment" : "Post comment"}
                style={[styles.send, { opacity: canSubmitComment(draft) && !busy ? 1 : 0.4 }]}
              >
                {busy ? (
                  <ActivityIndicator color="#16161a" size="small" />
                ) : (
                  <Ionicons name="arrow-up" size={20} color="#16161a" />
                )}
              </Pressable>
            </View>
            <Text style={[styles.guidelines, { color: t.subtext }]}>
              Keep it respectful. Comments that break our community guidelines are removed.
            </Text>
            {links.length > 0 ? (
              <View style={styles.footerLinks}>
                {links.map((link) => (
                  <HelpLinkText key={link.url} label={link.label} onPress={() => openLink(link.url)} small />
                ))}
              </View>
            ) : null}
          </View>
        ) : (
          <GoldButton label="Sign in to comment" onPress={() => requireAuth(() => undefined)} />
        )
      ) : null}
    </Sheet>
  );
}

function CommentRow({ comment, mine, onMenu }: { comment: Comment; mine: boolean; onMenu: () => void }) {
  const t = useTheme();
  return (
    <View style={styles.row}>
      <Avatar name={comment.authorName} seed={comment.authorId} size={32} />
      <View style={styles.rowBody}>
        <Text style={[styles.meta, { color: t.subtext }]}>
          {comment.authorName} · {commentAge(comment.createdAt)}
          {comment.editedAt ? " · edited" : ""}
          {comment.status === "pending" ? " · awaiting review" : ""}
        </Text>
        <Text style={[styles.text, { color: t.text }]}>{comment.body}</Text>
      </View>
      <Pressable
        onPress={onMenu}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={mine ? "Edit or delete your comment" : `Report or block ${comment.authorName}`}
      >
        <Ionicons name="ellipsis-horizontal" size={18} color={t.subtext} />
      </Pressable>
    </View>
  );
}

function HelpLinkText({ label, onPress, small }: { label: string; onPress: () => void; small?: boolean }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="link" accessibilityLabel={label} hitSlop={6}>
      <Text style={{ color: t.accent, fontSize: small ? 12 : 14, paddingVertical: small ? 2 : 6 }}>{label}</Text>
    </Pressable>
  );
}

function MenuRow({
  icon,
  label,
  danger,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  danger?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const color = danger ? "#e0245e" : t.text;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.menuRow, { borderColor: t.line, opacity: pressed ? 0.7 : 1 }]}
    >
      <Ionicons name={icon} size={18} color={color} />
      <Text style={[styles.menuLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  state: { textAlign: "center", paddingVertical: tokens.spacing.xl },
  row: { flexDirection: "row", gap: tokens.spacing.md, paddingVertical: tokens.spacing.sm, alignItems: "flex-start" },
  rowBody: { flex: 1, gap: 2 },
  meta: { fontSize: 12 },
  text: { fontSize: 15, lineHeight: 20 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: tokens.spacing.sm, paddingTop: tokens.spacing.sm },
  input: {
    flex: 1,
    maxHeight: 96,
    borderRadius: tokens.radius,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    fontSize: 15,
  },
  send: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.color.gold,
  },
  error: { color: "#e0245e", fontSize: 13, paddingTop: tokens.spacing.sm },
  guidelines: { fontSize: 11, paddingTop: tokens.spacing.sm },
  guideline: { fontSize: 14, lineHeight: 20, paddingVertical: 2 },
  agree: { marginTop: tokens.spacing.md },
  footerLinks: { flexDirection: "row", gap: tokens.spacing.lg, paddingTop: tokens.spacing.xs },
  editing: { flexDirection: "row", justifyContent: "space-between", paddingTop: tokens.spacing.sm },
  panel: { gap: tokens.spacing.xs },
  panelTitle: { fontSize: 14, paddingVertical: tokens.spacing.sm },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
    paddingVertical: tokens.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  menuLabel: { fontSize: 16 },
});
