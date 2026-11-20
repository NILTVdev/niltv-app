/** My posts: the athlete's published clips on niltv.com, newest first. */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { compactNumber, plural } from "../lib/format";
import { formatShortDate } from "../lib/time";
import { pathFor } from "../lib/router";
import { qk } from "../queries";
import { Empty, ErrorNote, Loading, PageHead } from "../ui/bits";
import { Link } from "../ui/Link";
import { useMe } from "../ui/me";

export function MyPosts() {
  const { zone } = useMe();
  const posts = useQuery({ queryKey: qk.myPosts, queryFn: api.myPosts });
  const list = posts.data?.posts ?? [];
  const views = list.reduce((sum, p) => sum + p.views, 0);
  const top = list.reduce((max, p) => Math.max(max, p.views), 0);
  // Nothing records views yet; a row of zeros would read as no reach at all.
  const hasViews = views > 0;

  return (
    <>
      <PageHead title="My posts" sub="Everything NIL TV has published with you in it." access="You and staff" />
      {posts.isPending ? <Loading /> : null}
      <ErrorNote error={posts.error} onRetry={() => void posts.refetch()} />
      {posts.data && !posts.data.linked ? (
        <Empty>
          Your account is not linked to an athlete page on niltv.com yet, so we cannot list your posts.{" "}
          <Link className="linkbtn" to={pathFor("help")}>
            Ask the team to link it
          </Link>
        </Empty>
      ) : null}
      {posts.data?.linked && list.length === 0 ? <Empty>Nothing published with you in it yet.</Empty> : null}
      {list.length ? (
        <>
          <div className="stats">
            <div className="stat">
              <b>{list.length}</b>
              <span>{list.length === 1 ? "Post" : "Posts"}</span>
            </div>
            {hasViews ? (
              <>
                <div className="stat">
                  <b>{compactNumber(views)}</b>
                  <span>Views</span>
                </div>
                <div className="stat">
                  <b>{compactNumber(top)}</b>
                  <span>Top post</span>
                </div>
              </>
            ) : null}
          </div>
          <ul className="posters" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {list.map((p) => (
              <li className="poster" key={p.id}>
                <div className="frame">
                  {p.posterUrl ? <img src={p.posterUrl} alt="" loading="lazy" decoding="async" /> : null}
                  <span className="ttl">{p.title}</span>
                </div>
                <div className="meta">
                  <span>{p.publishedAt ? formatShortDate(p.publishedAt, zone) : "Not dated"}</span>
                  {hasViews ? <b aria-label={plural(p.views, "view")}>{compactNumber(p.views)}</b> : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
