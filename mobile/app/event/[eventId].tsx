/**
 * Event detail (spec §5.4): one route, three renders keyed off the
 * SERVER-stored status — upcoming (countdown + notify), live (finalist grid →
 * pick → vote → confirm + share), ended (frozen recap). Countdowns tick
 * client-side off server timestamps (design §3.2); the vote path is the §6.3
 * integrity sequence with a typed-error UX state for every gate.
 */
import type { EntryDetail, EventDetailResponse, EventEntity } from "@niltv/types";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { VideoView, useVideoPlayer } from "expo-video";
import { useCallback, useState } from "react";
import {
  Image,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useEvent, useMe, useVote } from "@/api/hooks";
import { ApiRequestError } from "@/api/client";
import { requireAuth } from "@/auth/store";
import { Avatar } from "@/components/Avatar";
import { Banner } from "@/components/Banner";
import { CompetitionMark } from "@/components/Brand";
import { GoldButton } from "@/components/GoldButton";
import { NewsletterBand } from "@/components/NewsletterBand";
import { Pill } from "@/components/Pill";
import { AboutSection, ChecklistSection, FaqSection, LegalLink } from "@/components/EventInfoSections";
import { ErrorState, LoadingState } from "@/components/ScreenState";
import { ShowcaseTitlePage } from "@/components/ShowcaseTitlePage";
import { SizzleReel } from "@/components/SizzleReel";
import { SubmissionsHero } from "@/components/SubmissionsHero";
import { useCountdown } from "@/hooks/useCountdown";
import { useNotifyMe } from "@/hooks/useNotifyMe";
import { inSubmissions } from "@/lib/events";
import { formatCount, nilSchool, schoolMeta } from "@/lib/format";
import { hapticError, hapticSuccess } from "@/lib/haptics";
import { goBack } from "@/lib/navigation";
import { track, useScreenView } from "@/telemetry";
import { tokens } from "@/theme/tokens";
import { useTheme } from "@/theme/useTheme";

function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

/** One finalist row: identity, live vote count, tap-to-expand bio + vote CTA. */
function FinalistRow({
  entry,
  expanded,
  votedFor,
  votingOpen,
  busy,
  onToggle,
  onVote,
}: {
  entry: EntryDetail;
  expanded: boolean;
  /** entryId the signed-in account voted for in this event, if any */
  votedFor: string | undefined;
  votingOpen: boolean;
  busy: boolean;
  onToggle: () => void;
  onVote: () => void;
}) {
  const t = useTheme();
  const isPick = votedFor === entry.id;
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${entry.name}, ${nilSchool(entry.school)}`}
      style={[
        styles.finalist,
        { backgroundColor: t.surface, borderColor: isPick ? t.accent : t.line },
        isPick && { borderWidth: 1.5 },
      ]}
    >
      <View style={styles.finalistTop}>
        <Avatar name={entry.name} seed={entry.athleteId} url={entry.avatarUrl} size={44} />
        <View style={styles.finalistInfo}>
          <Text numberOfLines={1} style={[styles.finalistName, { color: t.text }]}>
            {entry.name}
          </Text>
          <Text numberOfLines={2} style={[styles.finalistMeta, { color: t.subtext }]}>
            {schoolMeta(entry.school, entry.sport)}
          </Text>
        </View>
        {isPick ? (
          <Pill label="YOUR PICK" />
        ) : (
          <Text style={[styles.votes, { color: t.subtext }]}>{formatCount(entry.votes)} votes</Text>
        )}
      </View>
      {expanded ? (
        <View style={styles.finalistBody}>
          {entry.bio ? (
            <Text style={[styles.bio, { color: t.subtext }]}>{entry.bio}</Text>
          ) : null}
          {votingOpen ? (
            isPick ? (
              <GoldButton label="Your vote is in ★" variant="outline" onPress={() => undefined} disabled />
            ) : (
              <GoldButton
                label={votedFor ? "You already voted in this event" : `Vote for ${entry.name}`}
                onPress={onVote}
                busy={busy}
                disabled={votedFor !== undefined}
              />
            )
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

/** The competition lockup for the event's brand, when we have one. It leads
 * the page (the prize is the loudest element AFTER the logo), so it renders
 * at hero scale rather than thumbnail scale. */
function EventLogo({ title }: { title: string }) {
  return <CompetitionMark title={title} height={96} style={styles.eventLogo} />;
}

/**
 * The prize at hero scale (web principle: the prize is the loudest element on
 * the page after the logo). Recaps carry it inside the showcase heading.
 */
function PrizeHero({ prize }: { prize: string }) {
  const t = useTheme();
  return (
    <View style={styles.prizeWrap}>
      <Text style={[styles.prizeLabel, { color: t.accent }]}>Grand Prize</Text>
      <Text style={[styles.prize, { color: t.text }]}>{prize}</Text>
    </View>
  );
}

/** Tappable 9:16 winner-announcement video (site recap's winner card). */
function WinnerVideo({ videoUrl, posterUrl }: { videoUrl: string; posterUrl?: string }) {
  const { width } = useWindowDimensions();
  const w = Math.min(width - tokens.spacing.lg * 2, 320);
  const [started, setStarted] = useState(false);
  // Source loads on first tap only — a preloading player made the whole recap
  // scroll janky before anyone pressed play.
  const player = useVideoPlayer(null, (p) => {
    p.loop = true;
  });
  // Never play under a pushed screen (the app-wide audio rule).
  useFocusEffect(useCallback(() => () => player.pause(), [player]));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Play winner announcement"
      onPress={() => {
        if (player.playing) player.pause();
        else if (started) player.play();
        else {
          setStarted(true);
          player.replaceAsync(videoUrl).then(() => player.play()).catch(() => setStarted(false));
        }
      }}
      style={[styles.winnerVideo, { width: w, height: (w * 16) / 9 }]}
    >
      <VideoView player={player} nativeControls={false} contentFit="cover" surfaceType="textureView" style={[StyleSheet.absoluteFill, styles.videoSurface]} />
      {!started ? (
        <>
          {posterUrl ? (
            <Image source={{ uri: posterUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityIgnoresInvertColors />
          ) : null}
          <View style={styles.winnerPlayWrap}>
            <View style={styles.winnerPlay}>
              <Ionicons name="play" size={24} color="#1a1a1f" style={{ marginLeft: 2 }} />
            </View>
          </View>
        </>
      ) : null}
    </Pressable>
  );
}

/**
 * Site-mirrored season recap (display-only — niltv.com/nilstar is the source
 * of truth; finalists here are not profile records).
 */
function ShowcaseRecap({ showcase }: { showcase: NonNullable<EventEntity["showcase"]> }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const cardW = (width - tokens.spacing.lg * 2 - tokens.spacing.md) / 2;
  return (
    <>
      <View style={[styles.champion, { borderColor: t.accent }]}>
        <Pill label="YOUR FIRST EVER NIL STAR" />
        <Text style={[styles.showcaseHeading, { color: t.text }]}>{showcase.heading}</Text>
        <Text style={[styles.championName, { color: t.text }]}>{showcase.winner.name}</Text>
        <Text style={[styles.finalistMeta, { color: t.subtext }]}>
          {schoolMeta(showcase.winner.school, showcase.winner.sport)}
        </Text>
        {showcase.winner.videoUrl ? (
          <WinnerVideo videoUrl={showcase.winner.videoUrl} posterUrl={showcase.winner.posterUrl} />
        ) : null}
      </View>

      {showcase.finalists.length > 0 ? (
        <>
          <Text style={[styles.section, { color: t.text }]}>
            The Top {showcase.finalists.length + 1}
          </Text>
          <View style={styles.showcaseGrid}>
            {/* The champion leads the grid — an even 20, no blank half-row. */}
            <View
              key={showcase.winner.name}
              style={[styles.showcaseCard, { width: cardW, backgroundColor: t.surface, borderColor: t.accent }]}
            >
              {showcase.winner.posterUrl ? (
                <Image
                  source={{ uri: showcase.winner.posterUrl }}
                  style={styles.showcasePhoto}
                  resizeMode="cover"
                  accessibilityIgnoresInvertColors
                />
              ) : (
                <View style={[styles.showcasePhoto, { backgroundColor: t.inset }]} />
              )}
              <Text numberOfLines={1} style={[styles.finalistName, { color: t.text }]}>
                {showcase.winner.name}
              </Text>
              <Text numberOfLines={3} style={[styles.finalistMeta, { color: t.subtext }]}>
                {`Champion · ${schoolMeta(showcase.winner.school, showcase.winner.sport)}`}
              </Text>
            </View>
            {showcase.finalists.map((f) => (
              <View
                key={f.name}
                style={[styles.showcaseCard, { width: cardW, backgroundColor: t.surface, borderColor: t.line }]}
              >
                {f.photoUrl ? (
                  <Image
                    source={{ uri: f.photoUrl }}
                    style={styles.showcasePhoto}
                    resizeMode="cover"
                    accessibilityIgnoresInvertColors
                  />
                ) : (
                  <View style={[styles.showcasePhoto, { backgroundColor: t.inset }]} />
                )}
                <Text numberOfLines={1} style={[styles.finalistName, { color: t.text }]}>
                  {f.name}
                </Text>
                <Text numberOfLines={3} style={[styles.finalistMeta, { color: t.subtext }]}>
                  {schoolMeta(f.school, f.sport)}
                </Text>
              </View>
            ))}
          </View>
        </>
      ) : null}
    </>
  );
}

/** Official competition timeline (upcoming events carrying milestones). */
function Timeline({ milestones }: { milestones: NonNullable<EventEntity["milestones"]> }) {
  const t = useTheme();
  return (
    <View style={styles.timeline}>
      {milestones.map((m, i) => (
        <View key={m.date + m.label} style={styles.timelineRow}>
          <View style={styles.timelineRail}>
            <View style={[styles.timelineDot, { backgroundColor: t.accent }]} />
            {i < milestones.length - 1 ? (
              <View style={[styles.timelineLine, { backgroundColor: t.line }]} />
            ) : null}
          </View>
          <View style={styles.timelineBody}>
            <Text style={[styles.timelineDate, { color: t.accent }]}>{m.date}</Text>
            <Text style={[styles.timelineLabel, { color: t.text }]}>{m.label}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/** Frozen recap (design §6.5: never recomputed — rendered verbatim). */
function Recap({ data }: { data: EventDetailResponse }) {
  const t = useTheme();
  // Site-mirrored showcase wins over the entries-based leaderboard (§ redesign
  // plan: the app reflects niltv.com).
  if (data.event.showcase) {
    return <ShowcaseRecap showcase={data.event.showcase} />;
  }
  const recap = data.recap;
  const byId = new Map(data.entries.map((e) => [e.id, e]));
  if (!recap) {
    return <Text style={[styles.bio, { color: t.subtext }]}>Results are being finalized.</Text>;
  }
  const champion = byId.get(recap.championEntryId);
  return (
    <>
      {champion ? (
        <View style={[styles.champion, { borderColor: t.accent }]}>
          <Pill label="CHAMPION" />
          <View style={styles.championRow}>
            <Avatar name={champion.name} seed={champion.athleteId} url={champion.avatarUrl} size={54} />
            <View style={styles.finalistInfo}>
              <Text style={[styles.championName, { color: t.text }]}>{champion.name}</Text>
              <Text style={[styles.finalistMeta, { color: t.subtext }]}>
                {schoolMeta(champion.school, champion.sport)}
              </Text>
            </View>
          </View>
        </View>
      ) : null}

      <Text style={[styles.section, { color: t.text }]}>Final leaderboard</Text>
      {recap.leaderboard.map((row) => {
        const entry = byId.get(row.entryId);
        return (
          <View key={row.entryId} style={[styles.leaderRow, { borderColor: t.line }]}>
            <Text style={[styles.rank, { color: t.accent }]}>#{row.rank}</Text>
            <Text numberOfLines={1} style={[styles.leaderName, { color: t.text }]}>
              {entry?.name ?? row.entryId}
            </Text>
            <Text style={[styles.votes, { color: t.subtext }]}>{formatCount(row.votes)} votes</Text>
          </View>
        );
      })}

      <View style={styles.totals}>
        <Stat label="Total votes" value={formatCount(recap.totals.votes)} />
        <Stat label="Finalists" value={String(recap.totals.entries)} />
        <Stat label="Days live" value={String(recap.totals.daysLive)} />
      </View>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <View style={[styles.stat, { backgroundColor: t.surface, borderColor: t.line }]}>
      <Text style={[styles.statValue, { color: t.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: t.subtext }]}>{label}</Text>
    </View>
  );
}

export default function EventScreen() {
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  // Intro reel sizing (matches the newsletter treatment): ~55% of the
  // viewport tall, capped by the content column on wide windows.
  const introW = Math.min(width - tokens.spacing.lg * 2, Math.round(height * 0.55 * (9 / 16)));
  const params = useLocalSearchParams<{ eventId: string }>();
  const eventId = params.eventId ?? "";

  const detail = useEvent(eventId);
  const me = useMe();
  const vote = useVote();
  const notifyMe = useNotifyMe();
  useScreenView("event", { eventId });

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);

  const data = detail.data;
  // Stage 1 of the arc (submissions): the countdown targets the entry cutoff,
  // not the voting open. Once the cutoff passes, the tick re-renders and this
  // flips back to the plain voting countdown.
  const submissionsOpen = data !== undefined && inSubmissions(data.event);
  const countdown = useCountdown(
    data?.event.status === "live"
      ? data.event.endsAt
      : data?.event.status === "upcoming"
        ? submissionsOpen
          ? data.event.entriesCloseAt
          : data.event.startsAt
        : undefined,
  );

  const votedFor = me.data?.votes[eventId];
  const under18 = me.data !== undefined && !me.data.is18plus;

  function castVote(entry: EntryDetail) {
    setVoteError(null);
    // Gated action (design §3.3): guests get the auth sheet, then the tap resumes.
    requireAuth(() => {
      vote.mutate(
        { eventId, entryId: entry.id },
        {
          onSuccess: () => {
            hapticSuccess();
            void Share.share({
              message: `I just voted for ${entry.name} in ${data?.event.title ?? "NIL STAR"}: https://app.niltv.com/event/${eventId}`,
            }).catch(() => undefined);
          },
          onError: (err) => {
            hapticError();
            const code = err instanceof ApiRequestError ? err.code : "HTTP_ERROR";
            setVoteError(
              code === "AGE_GATE"
                ? "Voting is limited to users 18 and older (prize-competition rules)."
                : code === "WINDOW_CLOSED"
                  ? "Voting just closed for this event."
                  : code === "ALREADY_VOTED"
                    ? "This account has already voted in this event."
                    : "Something went wrong. Please try again.",
            );
            void detail.refetch();
          },
        },
      );
    });
  }

  if (!data) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: t.bg }]}>
        <View style={styles.header}>
          <Pressable onPress={() => goBack()} accessibilityRole="button" accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={26} color={t.text} />
          </Pressable>
        </View>
        {detail.isError ? <ErrorState onRetry={() => void detail.refetch()} /> : <LoadingState />}
      </SafeAreaView>
    );
  }

  const ev = data.event;

  // Season recap with a showcase → the network title page (full-bleed hero,
  // episode rail) replaces the shared banner chrome entirely.
  if (ev.status === "ended" && ev.showcase) {
    return (
      <ShowcaseTitlePage
        event={ev}
        refreshing={detail.isRefetching}
        onRefresh={() => void detail.refetch()}
      />
    );
  }

  const isLive = ev.status === "live";
  // Submissions phase renders the full-bleed hero: the reel
  // owns the first viewport under the status bar and carries its own back
  // chevron + title, so the screen header and the lockup row stand down.
  const fullBleedHero = ev.status === "upcoming" && submissionsOpen && ev.submitUrl !== undefined;

  return (
    <SafeAreaView edges={fullBleedHero ? [] : ["top"]} style={[styles.screen, { backgroundColor: t.bg }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={detail.isRefetching}
            onRefresh={() => void detail.refetch()}
            tintColor={t.accent}
            colors={[t.accent]}
            progressBackgroundColor={t.surface}
          />
        }
      >
        {fullBleedHero ? null : (
          <View style={styles.header}>
            <Pressable onPress={() => goBack()} accessibilityRole="button" accessibilityLabel="Back">
              <Ionicons name="chevron-back" size={26} color={t.text} />
            </Pressable>
            <Text numberOfLines={1} style={[styles.headerTitle, { color: t.text }]}>
              {ev.title}
            </Text>
          </View>
        )}

        {fullBleedHero ? null : (
          <>
            <EventLogo title={ev.title} />
            {ev.prize && ev.status !== "ended" ? <PrizeHero prize={ev.prize} /> : null}
          </>
        )}

        {/* ── Status hero ───────────────────────────────────────────────── */}
        {fullBleedHero ? (
          /* Full-bleed hero: the reel is the screen; the prize is the
             headline; state and the Submit CTA ride the layout scrim. */
          <SubmissionsHero
            title={ev.title}
            prize={ev.prize}
            videoUrl={ev.introVideoUrl}
            countdownLine={`Free to enter · Entries close ${longDate(ev.entriesCloseAt ?? ev.startsAt)}`}
            onSubmit={() => {
              track("submit_entry_tap", { eventId });
              void Linking.openURL(ev.submitUrl as string).catch(() => undefined);
            }}
            onBack={() => goBack()}
            style={styles.heroBleed}
          />
        ) : ev.status === "upcoming" ? (
          <Banner
            badge="UPCOMING"
            title={ev.title}
            subtitle={[
              ev.blurb,
              countdown && countdown !== "Ended" ? `Voting opens in ${countdown}` : `Starts ${longDate(ev.startsAt)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
            cta="Notify Me"
            onCtaPress={() =>
              notifyMe(eventId, () =>
                setNote("You're on the list. We'll ping you when voting opens."),
              )
            }
          />
        ) : isLive ? (
          <Banner
            badge="LIVE · VOTING OPEN"
            live
            title={ev.title}
            subtitle={[ev.prize, countdown && countdown !== "Ended" ? `Voting closes in ${countdown}` : null]
              .filter(Boolean)
              .join(" · ")}
          />
        ) : (
          <Banner badge="RECAP" title={ev.title} subtitle={`Ended ${longDate(ev.endsAt)}`} />
        )}

        {/* Under the reel: the competition mark at hero scale,
            leading into the roadmap sections below. */}
        {fullBleedHero ? (
          <CompetitionMark
            title={ev.title}
            width={Math.min(width - tokens.spacing.lg * 2, 420)}
            style={styles.bigMark}
          />
        ) : null}

        {note ? <Text style={[styles.note, { color: t.subtext }]}>{note}</Text> : null}

        {/* Outside submissions, the network intro reel still leads upcoming
            pages (the web rebuild's header treatment) as a plain showcase. */}
        {ev.status === "upcoming" && !submissionsOpen ? (
          <View style={styles.introWrap}>
            <SizzleReel variant="portrait" style={{ width: introW, alignSelf: "center" }} />
          </View>
        ) : null}

        {/* ── Body by status ────────────────────────────────────────────── */}
        {ev.status === "ended" ? (
          <>
            <Recap data={data} />
            {/* Recap newsletter entry point (spec §5.6). */}
            <NewsletterBand
              source="recap"
              title="Don't miss the next one"
              copy="Get the next NIL STAR voting window in your inbox."
            />
          </>
        ) : (
          <>
            {isLive && under18 ? (
              <View style={[styles.notice, { backgroundColor: t.surface, borderColor: t.line }]}>
                <Ionicons name="information-circle-outline" size={18} color={t.subtext} />
                <Text style={[styles.noticeText, { color: t.subtext }]}>
                  You can follow along, but voting is limited to users 18+ (prize-competition
                  rules).
                </Text>
              </View>
            ) : null}
            {voteError ? (
              <View style={[styles.notice, { backgroundColor: t.surface, borderColor: t.line }]}>
                <Ionicons name="alert-circle-outline" size={18} color={t.subtext} />
                <Text style={[styles.noticeText, { color: t.subtext }]}>{voteError}</Text>
              </View>
            ) : null}
            {votedFor && isLive ? (
              <>
                <View style={[styles.notice, { backgroundColor: t.surface, borderColor: t.accent }]}>
                  <Ionicons name="checkmark-circle" size={18} color={t.accent} />
                  <Text style={[styles.noticeText, { color: t.text }]}>
                    Your vote is in. Results land {longDate(ev.endsAt)}.
                  </Text>
                </View>
                {/* Post-vote newsletter entry point (spec §5.6). */}
                <NewsletterBand
                  source="post_vote"
                  title="Follow the race"
                  copy="Results and the next voting window, straight to your inbox."
                />
              </>
            ) : null}

            <Text style={[styles.section, { color: t.text }]}>
              {isLive ? "Vote for your finalist" : ev.milestones ? "The road to the title" : "Finalists"}
            </Text>
            {data.entries.length === 0 && ev.milestones ? (
              /* Official competition timeline until finalists exist. */
              <Timeline milestones={ev.milestones} />
            ) : data.entries.length === 0 ? (
              <Text style={[styles.bio, { color: t.subtext }]}>
                Finalists are announced soon.
              </Text>
            ) : (
              data.entries.map((entry) => (
                <FinalistRow
                  key={entry.id}
                  entry={entry}
                  expanded={expandedId === entry.id}
                  votedFor={votedFor}
                  votingOpen={isLive && !under18}
                  busy={vote.isPending && vote.variables?.entryId === entry.id}
                  onToggle={() => {
                    track("card_tap", { entryId: entry.id, from: "event_finalists" });
                    setExpandedId(expandedId === entry.id ? null : entry.id);
                  }}
                  onVote={() => castVote(entry)}
                />
              ))
            )}
          </>
        )}

        {/* ── Submissions-page content (spec stage 1) ───────────────────── */}
        {ev.about ? <AboutSection about={ev.about} /> : null}
        {submissionsOpen && ev.checklist ? <ChecklistSection checklist={ev.checklist} /> : null}
        {ev.faq ? <FaqSection faq={ev.faq} /> : null}

        {/* ── Partners ──────────────────────────────────────────────────── */}
        {ev.partners.length > 0 ? (
          <>
            <Text style={[styles.section, { color: t.text }]}>Partners</Text>
            <View style={styles.partners}>
              {ev.partners.map((partner) => (
                <View key={partner} style={[styles.partner, { backgroundColor: t.surface, borderColor: t.line }]}>
                  <Text style={[styles.partnerLabel, { color: t.subtext }]}>{partner}</Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {ev.legalUrl ? <LegalLink url={ev.legalUrl} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: tokens.spacing.lg,
    paddingBottom: tokens.spacing.xl * 2,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.sm,
    paddingVertical: tokens.spacing.md,
  },
  headerTitle: {
    fontFamily: tokens.font.extrabold,
    fontSize: 19,
    flex: 1,
  },
  note: {
    fontFamily: tokens.font.regular,
    fontSize: 12,
    marginTop: tokens.spacing.sm,
  },
  introWrap: {
    marginTop: tokens.spacing.lg,
  },
  // The full-bleed hero escapes the content column's gutter to reach the
  // screen edges; everything after it stays inside the padded column.
  heroBleed: {
    marginHorizontal: -tokens.spacing.lg,
  },
  bigMark: {
    alignSelf: "center",
    marginTop: tokens.spacing.xl,
  },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.sm,
    borderWidth: 1,
    borderRadius: tokens.radius,
    padding: tokens.spacing.md,
    marginTop: tokens.spacing.md,
  },
  noticeText: {
    flex: 1,
    fontFamily: tokens.font.regular,
    fontSize: 13,
    lineHeight: 18,
  },
  section: {
    fontFamily: tokens.font.extrabold,
    fontSize: 17,
    marginTop: tokens.spacing.xl,
    marginBottom: tokens.spacing.md,
  },
  finalist: {
    borderWidth: 1,
    borderRadius: tokens.radius,
    padding: tokens.spacing.md,
    marginBottom: 10,
  },
  finalistTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
  },
  finalistInfo: {
    flex: 1,
    minWidth: 0,
  },
  finalistName: {
    fontFamily: tokens.font.bold,
    fontSize: 15,
  },
  finalistMeta: {
    fontFamily: tokens.font.regular,
    fontSize: 12,
    marginTop: 2,
  },
  votes: {
    fontFamily: tokens.font.bold,
    fontSize: 12,
  },
  finalistBody: {
    marginTop: tokens.spacing.md,
    gap: tokens.spacing.md,
  },
  bio: {
    fontFamily: tokens.font.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  champion: {
    borderWidth: 1.5,
    borderRadius: tokens.radius,
    padding: tokens.spacing.lg,
    marginTop: tokens.spacing.xl,
    gap: tokens.spacing.md,
    alignItems: "flex-start",
  },
  championRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
    alignSelf: "stretch",
  },
  championName: {
    fontFamily: tokens.font.extrabold,
    fontSize: 18,
  },
  leaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacing.md,
    borderWidth: 1,
    borderRadius: tokens.radius,
    paddingVertical: 10,
    paddingHorizontal: tokens.spacing.md,
    marginBottom: 8,
  },
  rank: {
    fontFamily: tokens.font.extrabold,
    fontSize: 14,
    width: 34,
  },
  leaderName: {
    flex: 1,
    fontFamily: tokens.font.bold,
    fontSize: 14,
  },
  totals: {
    flexDirection: "row",
    gap: tokens.spacing.md,
    marginTop: tokens.spacing.lg,
  },
  stat: {
    flex: 1,
    borderWidth: 1,
    borderRadius: tokens.radius,
    alignItems: "center",
    paddingVertical: tokens.spacing.md,
  },
  statValue: {
    fontFamily: tokens.font.extrabold,
    fontSize: 18,
  },
  statLabel: {
    fontFamily: tokens.font.regular,
    fontSize: 11,
    marginTop: 2,
  },
  partners: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.spacing.sm,
  },
  partner: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  partnerLabel: {
    fontFamily: tokens.font.bold,
    fontSize: 12,
  },
  eventLogo: {
    alignSelf: "center",
    marginTop: tokens.spacing.sm,
    marginBottom: tokens.spacing.md,
  },
  // Two type sizes in the lockup zone (hero type discipline): the 12px label
  // and the prize line — nothing between.
  prizeWrap: {
    alignItems: "center",
    marginBottom: tokens.spacing.lg,
  },
  prizeLabel: {
    fontFamily: tokens.font.extrabold,
    fontSize: 13,
    letterSpacing: 2.4,
    textTransform: "uppercase",
  },
  prize: {
    fontFamily: tokens.font.extrabold,
    fontSize: 44,
    letterSpacing: 0.2,
    marginTop: 2,
  },
  showcaseHeading: {
    fontFamily: tokens.font.regular,
    fontSize: 14,
  },
  videoSurface: {
    width: "100%",
    height: "100%",
  },
  winnerVideo: {
    alignSelf: "center",
    borderRadius: tokens.radius,
    overflow: "hidden",
    backgroundColor: "#000000",
    marginTop: tokens.spacing.md,
  },
  winnerPlayWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
  },
  winnerPlay: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: tokens.color.gold,
    alignItems: "center",
    justifyContent: "center",
  },
  showcaseGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.spacing.md,
  },
  showcaseCard: {
    borderWidth: 1,
    borderRadius: tokens.radius,
    padding: tokens.spacing.sm,
    gap: 4,
  },
  showcasePhoto: {
    width: "100%",
    aspectRatio: 3 / 4,
    borderRadius: tokens.radius - 4,
    marginBottom: 4,
  },
  timeline: {
    marginTop: tokens.spacing.sm,
  },
  timelineRow: {
    flexDirection: "row",
    gap: tokens.spacing.md,
  },
  timelineRail: {
    alignItems: "center",
    width: 14,
  },
  timelineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 4,
  },
  timelineLine: {
    width: 2,
    flex: 1,
    marginVertical: 3,
  },
  timelineBody: {
    flex: 1,
    paddingBottom: tokens.spacing.lg,
  },
  timelineDate: {
    fontFamily: tokens.font.bold,
    fontSize: 12,
    letterSpacing: 0.4,
  },
  timelineLabel: {
    fontFamily: tokens.font.regular,
    fontSize: 14,
    lineHeight: 19,
    marginTop: 2,
  },
});
