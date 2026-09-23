import { Feather, Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { Platform } from "react-native";

import { hapticSelect } from "@/lib/haptics";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

/**
 * Home / Competitions / Channels / Featured / Profile. The competitions tab
 * keeps its route name (nilstar) and its star icon; only the label reads
 * "Competitions", the site's nav word. Featured mirrors the
 * site's /featured/ page.
 */
export default function TabLayout() {
  const t = useTheme();
  return (
    <Tabs
      screenListeners={{
        tabPress: () => hapticSelect(),
      }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: tokens.color.gold,
        tabBarInactiveTintColor: t.subtext,
        tabBarStyle: {
          backgroundColor: t.bg,
          borderTopColor: t.line,
          // Web has no safe-area inset, so size the bar explicitly there.
          // Native keeps the default height + home-indicator inset intact.
          ...(Platform.OS === "web" ? { height: 62, paddingTop: 6, paddingBottom: 8 } : {}),
        },
        tabBarLabelStyle: {
          fontFamily: tokens.font.semibold,
          fontSize: 11,
          // Custom fonts need an explicit lineHeight in the tab bar or the
          // computed line box clips descenders (Channels, Profile).
          lineHeight: 15,
        },
      }}
    >
      {/* Outline icon set: line-art icons,
          active state carried by the gold tint, grid glyph for Channels. */}
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => <Feather name="home" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="nilstar"
        options={{
          title: "Competitions",
          tabBarIcon: ({ color, size }) => <Ionicons name="star-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="channels"
        options={{
          title: "Channels",
          tabBarIcon: ({ color, size }) => <Ionicons name="grid-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="featured"
        options={{
          title: "Featured",
          tabBarIcon: ({ color, size }) => <Ionicons name="film-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
