import { Stack } from "expo-router";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import { useBlocks, useUnblockUser } from "@/api/hooks";
import { Avatar } from "@/components/Avatar";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";
import { useScreenView } from "@/telemetry";

/** Blocked users, with Unblock. Reached from Profile; required alongside in-comment Block. */
export default function BlockedUsersScreen() {
  useScreenView("blocked_users");
  const t = useTheme();
  const blocks = useBlocks();
  const unblock = useUnblockUser();

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <Stack.Screen options={{ headerShown: true, title: "Blocked users" }} />
      {blocks.isPending ? (
        <ActivityIndicator color={t.accent} style={styles.state} />
      ) : blocks.isError ? (
        <Pressable onPress={() => void blocks.refetch()} accessibilityRole="button">
          <Text style={[styles.state, { color: t.subtext }]}>Couldn&apos;t load. Tap to retry.</Text>
        </Pressable>
      ) : (
        <FlatList
          data={blocks.data.blocks}
          keyExtractor={(b) => b.userId}
          ListEmptyComponent={<Text style={[styles.state, { color: t.subtext }]}>You haven&apos;t blocked anyone.</Text>}
          renderItem={({ item }) => (
            <View style={[styles.row, { borderColor: t.line }]}>
              <Avatar name={item.name} seed={item.userId} size={36} />
              <Text style={[styles.name, { color: t.text }]}>{item.name}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Unblock ${item.name}`}
                onPress={() =>
                  unblock.mutate(item.userId, {
                    onError: () => Alert.alert("Something went wrong", "That user wasn't unblocked. Please try again."),
                  })
                }
              >
                <Text style={{ color: t.accent, fontFamily: tokens.font.semibold }}>Unblock</Text>
              </Pressable>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: tokens.spacing.xl },
  state: { textAlign: "center", paddingVertical: tokens.spacing.xl },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
    paddingVertical: tokens.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  name: { flex: 1, fontSize: 16 },
});
