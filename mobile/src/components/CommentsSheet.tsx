import type { Comment, CommentReportReason } from "@niltv/types";
import { COMMENT_MAX_LENGTH } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";

import {
  useBlockUser,
  useComments,
  useMe,
  usePostComment,
  useReportComment,
} from "@/api/hooks";
import { useAuthStore, requireAuth } from "@/auth/store";
import { Avatar } from "@/components/Avatar";
import { GoldButton } from "@/components/GoldButton";
import { Sheet } from "@/components/Sheet";
import { canSubmitComment, commentAge, postErrorMessage } from "@/lib/comments";
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

type Panel = { kind: "menu"; comment: Comment } | { kind: "report"; comment: Comment } | null;

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
  const comments = useComments(contentId, visible);
  const post = usePostComment(contentId);
  const report = useReportComment(contentId);
  const block = useBlockUser();

  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState<string | null>(null);

  const items = comments.data?.pages.flatMap((p) => p.comments) ?? [];

  function close() {
    setPanel(null);
    setError(null);
    onClose();
  }

  function submit() {
    if (!canSubmitComment(draft) || post.isPending) return;
    setError(null);
    post.mutate(draft.trim(), {
      onSuccess: (data) => {
        setDraft("");
        if (data.comment.status === "pending") {
          Alert.alert("Awaiting review", "Your comment will appear once our team has reviewed it.");
        }
      },
      onError: (e) => setError(postErrorMessage(e)),
    });
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
            onMenu={() => requireAuth(() => setPanel({ kind: "menu", comment: item }))}
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
            {error ? <Text style={styles.error}>{error}</Text> : null}
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
                disabled={!canSubmitComment(draft) || post.isPending}
                accessibilityRole="button"
                accessibilityLabel="Post comment"
                style={[styles.send, { opacity: canSubmitComment(draft) && !post.isPending ? 1 : 0.4 }]}
              >
                {post.isPending ? (
                  <ActivityIndicator color="#16161a" size="small" />
                ) : (
                  <Ionicons name="arrow-up" size={20} color="#16161a" />
                )}
              </Pressable>
            </View>
            <Text style={[styles.guidelines, { color: t.subtext }]}>
              Keep it respectful. Comments that break our community guidelines are removed.
            </Text>
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
          {comment.status === "pending" ? " · awaiting review" : ""}
        </Text>
        <Text style={[styles.text, { color: t.text }]}>{comment.body}</Text>
      </View>
      {mine ? null : (
        <Pressable
          onPress={onMenu}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Report or block ${comment.authorName}`}
        >
          <Ionicons name="ellipsis-horizontal" size={18} color={t.subtext} />
        </Pressable>
      )}
    </View>
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
