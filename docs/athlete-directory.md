# Athlete directory

The mobile `/profiles` screen has two views:

- **Discover** shows cleared athletes with a published video, ordered by their newest clip. Each card has one still preview that opens the video with the athlete's feed as swipe context.
- **All athletes** shows the full cleared roster alphabetically in compact rows. Published profiles open the profile; otherwise a video-bearing athlete opens their video list. Athletes with neither have a disabled row labeled “Videos coming soon.”

Search, school, and sport filters apply to both views and survive tab changes. A Discover search with no videos offers a link to the same search in All athletes.

A single optional spotlight uses the lowest existing staff-assigned ambassador rank among athletes with videos. It is omitted while filtering, and the spotlight athlete is excluded from the remaining cards. No new editorial settings are needed.

## API and rollout

`GET /v1/profiles?include=latestVideo` includes an optional `latestVideo` on each athlete chip (`id`, `title`, `thumbUrl`, `publishedAt`). The default endpoint and ambassador responses remain unchanged. The mobile Following screen continues using the default response.

The API reads the newest clip from each cleared athlete's sparse creator index, with at most eight queries running concurrently. It does not scan the content table. Preview responses are never persisted by the mobile client and use the directory endpoint's existing `no-store` policy. An API failure displays a retry state rather than claiming no videos exist.

Deploy the updated profiles-list API before releasing the updated mobile screen: the previous API ignores `include` and has no preview metadata to populate Discover. The regular athlete directory is independent of the ambassador feature flag; the ambassador rail and route retain that flag.
