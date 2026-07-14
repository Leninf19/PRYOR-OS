import { useState } from 'react'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Tabs from '../components/ui/Tabs.jsx'
import {
  useComplaintIntel, useCompetitorIntel, useMeta, useBestQuotes, useSeasonalTrends,
} from '../hooks/useIntelligence.js'

// ── Caption templates ─────────────────────────────────────────────────────────

function buildCaptions(topPraise, secondPraise, thirdPraise, bestLoc) {
  if (!topPraise) return null
  const item1 = topPraise
  const item2 = secondPraise ?? 'great food'
  const item3 = thirdPraise ?? 'friendly service'
  const loc   = bestLoc ?? 'one of our locations'
  return {
    facebook: `Our customers say it best — ${item1} keeps them coming back. Come try it for yourself this week. Tag us in your visit! 📸 #LosT resAmigos #Authentic${item1.replace(/\s/g, '')}`,
    instagram: `${item1.toUpperCase()} ✨ Your favorite reason to come back. Come visit us — because ${item2} and ${item3} taste even better in person. 📍 ${loc}`,
    google: `Try our ${item1} — it's one of the most praised items by our guests. Stop in and share your experience with us.`,
    campaign: `"${item1}" — Your New Favorite`,
    tagline: `Loved by our guests. Crafted for you.`,
  }
}

function buildCampaign(praises) {
  if (!praises?.length) return null
  const top3 = praises.slice(0, 3).map(p => p.name)
  const focus = top3[0]
  return {
    name: `"The Best of Los Tres Amigos" Campaign`,
    angle: `Highlight what customers already love most — ${top3.join(', ')} — and make it the centerpiece of your social and in-store presence.`,
    pillars: top3,
    photoIdeas: [
      `Close-up photo or Reel of ${top3[0]}`,
      top3[1] ? `Team member preparing or presenting ${top3[1]}` : 'Staff smiling at counter',
      'Packed dining room or patio — show the atmosphere',
      'Customer receiving their order — candid, authentic',
    ],
    videoIdeas: [
      `15-second Reel: making ${focus} from start to finish`,
      `"Reason to come back" — quick clips of top 3 praised items`,
      'Walk-through of the restaurant before service — ambient feel',
    ],
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PraiseCard({ cat, rank }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="card p-4 space-y-2 cursor-pointer" onClick={() => setOpen(o => !o)}>
      <div className="flex items-start gap-3">
        <span className="flex-shrink-0 text-[11px] font-black w-5 h-5 rounded-full flex items-center justify-center mt-0.5"
              style={{ background: 'rgba(16,185,129,0.12)', color: 'var(--color-success)' }}>
          {rank}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>{cat.name}</p>
            <Badge variant="success">Praised</Badge>
            {cat.trend === 'up'   && <Badge variant="success">↑ Rising</Badge>}
            {cat.trend === 'down' && <Badge variant="neutral">↓ Falling</Badge>}
          </div>
          <div className="flex items-center gap-4 mt-1">
            <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>
              <strong style={{ color: 'var(--color-text-1)' }}>{cat.count}</strong> mentions
            </span>
            <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>{cat.pct}% of reviews</span>
            {cat.delta !== 0 && (
              <span className={`text-xs font-medium ${cat.delta > 0 ? 'trend-up' : 'trend-down'}`}>
                {cat.delta > 0 ? `+${cat.delta}` : cat.delta} vs prior
              </span>
            )}
          </div>
          <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
            <div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, cat.pct * 3)}%`, background: 'var(--color-success)' }} />
          </div>
        </div>
        <svg className={`w-4 h-4 flex-shrink-0 mt-0.5 transition-transform ${open ? 'rotate-180' : ''}`}
             fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
             style={{ color: 'var(--color-text-3)' }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
      </div>
      {open && cat.examples?.length > 0 && (
        <div className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--color-border)' }}>
          <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
            Guest reviews
          </p>
          {cat.examples.slice(0, 3).map((ex, i) => (
            <div key={i} className="p-3 rounded-lg" style={{ background: 'var(--color-surface-2)' }}>
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>
                  {ex.reviewer_name || 'Guest'}
                </p>
                <div className="flex items-center gap-1.5">
                  {ex.location_name && <span className="badge badge-neutral">{ex.location_name}</span>}
                  {ex.star_rating   && <span className="text-xs font-bold" style={{ color: 'var(--color-accent)' }}>{'★'.repeat(ex.star_rating)}</span>}
                </div>
              </div>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)' }}>"{ex.review_text}"</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CaptionBlock({ platform, text }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <div className="card p-4 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--color-text-3)' }}>
          {platform}
        </p>
        <button onClick={copy} className="text-[10px] font-semibold transition-colors"
                style={{ color: copied ? 'var(--color-success)' : 'var(--color-accent)' }}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-1)', lineHeight: 1.7 }}>
        {text}
      </p>
      <p className="text-[9px] uppercase tracking-widest font-bold" style={{ color: 'var(--color-text-3)' }}>
        Template — edit before posting
      </p>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6 max-w-[900px]">
      <Skeleton className="h-7 w-64" />
      <div className="grid sm:grid-cols-2 gap-3">
        {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
      </div>
      <Skeleton className="h-48 rounded-2xl" />
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function MarketingIntelligence() {
  const { data: complaint,  isLoading: lC } = useComplaintIntel()
  const { data: competitor, isLoading: lR } = useCompetitorIntel()
  const { data: meta,       isLoading: lM } = useMeta()
  const { data: quotes }   = useBestQuotes()
  const { data: seasonal } = useSeasonalTrends()
  const [activeTab, setActiveTab] = useState('insights')

  const isLoading = lC || lR || lM

  if (isLoading) return <LoadingSkeleton />

  const praises  = complaint?.praises ?? []
  const rankings = competitor?.locationRankings ?? []
  const briefing = competitor?.weeklyBriefing ?? {}

  if (praises.length === 0) {
    return (
      <div className="max-w-[900px]">
        <div className="mb-6">
          <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Marketing Intelligence</h1>
        </div>
        <EmptyState
          icon="📣"
          title="No praise data yet"
          body="Marketing insights are generated from customer praise patterns in your reviews. Run the analytics pipeline to populate this page."
        />
      </div>
    )
  }

  const top3 = praises.slice(0, 3)
  const bestLoc = rankings.sort((a, b) => (b.positiveRate ?? 0) - (a.positiveRate ?? 0))[0]
  const captions = buildCaptions(top3[0]?.name, top3[1]?.name, top3[2]?.name, bestLoc?.name)
  const campaign = buildCampaign(praises)

  const TABS = [
    { id: 'insights',  label: 'What Customers Love' },
    { id: 'campaign',  label: 'Campaign Ideas'       },
    { id: 'captions',  label: 'Caption Templates'    },
    { id: 'trends',    label: 'Quotes & Seasonal Trends' },
  ]

  return (
    <div className="space-y-6 max-w-[900px]">

      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Marketing Intelligence</h1>
          <span className="badge badge-success">AI</span>
        </div>
        <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
          Marketing ideas grounded in what your customers actually say · {meta?.locations?.length ?? 21} locations
        </p>
      </div>

      {/* AI marketing opportunity from competitive briefing */}
      {briefing.marketingOpportunity && (
        <div className="rounded-2xl p-5 border"
             style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)',
                      borderLeftColor: 'var(--color-success)', borderLeftWidth: 3 }}>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] mb-2"
             style={{ color: 'var(--color-success)' }}>
            AI Marketing Signal
          </p>
          <p className="text-[15px] leading-relaxed" style={{ color: 'var(--color-text-1)', lineHeight: 1.8 }}>
            {briefing.marketingOpportunity}
          </p>
        </div>
      )}

      {/* Tabs */}
      <Tabs tabs={TABS} value={activeTab} onChange={setActiveTab} wrap={false} />

      {/* Tab: What Customers Love */}
      {activeTab === 'insights' && (
        <div className="space-y-4">
          <div className="flex items-baseline gap-3">
            <h2 className="text-title" style={{ color: 'var(--color-text-1)' }}>Most Praised by Guests</h2>
            <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
              {praises.length} praise themes identified · last 30 days
            </span>
          </div>
          <div className="space-y-3">
            {praises.slice(0, 8).map((cat, i) => (
              <PraiseCard key={cat.name} cat={cat} rank={i + 1} />
            ))}
          </div>

          {/* Best location for content */}
          {bestLoc && (
            <div className="rounded-2xl p-5 border mt-2"
                 style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] mb-2"
                 style={{ color: 'var(--color-text-3)' }}>
                Best Location for Content Creation
              </p>
              <p className="text-sm font-bold mb-1" style={{ color: 'var(--color-text-1)' }}>
                {bestLoc.name}
              </p>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
                Highest positive rate ({bestLoc.positiveRate?.toFixed(0)}%) across the network.
                Film here for the most authentic, guest-approved atmosphere and food shots.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Tab: Campaign Ideas */}
      {activeTab === 'campaign' && campaign && (
        <div className="space-y-4">
          <div className="rounded-2xl border overflow-hidden"
               style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
            <div className="px-5 pt-5 pb-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] mb-1"
                 style={{ color: 'var(--color-text-3)' }}>
                Recommended Campaign
              </p>
              <h3 className="text-lg font-black" style={{ color: 'var(--color-text-1)' }}>
                {campaign.name}
              </h3>
            </div>
            <div className="px-5 py-4 space-y-4">
              <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-2)', lineHeight: 1.75 }}>
                {campaign.angle}
              </p>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-[10px] uppercase tracking-widest font-bold mb-2"
                     style={{ color: 'var(--color-text-3)' }}>
                    Content Pillars
                  </p>
                  <ul className="space-y-1.5">
                    {campaign.pillars.map((p, i) => (
                      <li key={i} className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--color-success)' }} />
                        <span className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>{p}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-widest font-bold mb-2"
                     style={{ color: 'var(--color-text-3)' }}>
                    Photo / Video Ideas
                  </p>
                  <ul className="space-y-1.5">
                    {campaign.photoIdeas.slice(0, 4).map((idea, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5" style={{ background: 'var(--color-accent)' }} />
                        <span className="text-xs leading-snug" style={{ color: 'var(--color-text-2)' }}>{idea}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest font-bold mb-2"
                   style={{ color: 'var(--color-text-3)' }}>
                  Video / Reel Ideas
                </p>
                <ul className="space-y-1.5">
                  {campaign.videoIdeas.map((v, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5" style={{ background: 'var(--color-info)' }} />
                      <span className="text-xs leading-snug" style={{ color: 'var(--color-text-2)' }}>{v}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-[9px] pt-2" style={{ color: 'var(--color-text-3)' }}>
                Ideas are grounded in your review praise data. Adapt to your brand voice before publishing.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Caption Templates */}
      {activeTab === 'captions' && captions && (
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
            Generated from your top praised items. Edit to match your voice before posting.
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            <CaptionBlock platform="Facebook" text={captions.facebook} />
            <CaptionBlock platform="Instagram" text={captions.instagram} />
            <CaptionBlock platform="Google Business Post" text={captions.google} />
            <div className="card p-4 space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--color-text-3)' }}>
                Campaign Tagline
              </p>
              <p className="text-lg font-black" style={{ color: 'var(--color-text-1)' }}>{captions.campaign}</p>
              <p className="text-sm italic" style={{ color: 'var(--color-text-2)' }}>"{captions.tagline}"</p>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Best Quotes & Seasonal Trends */}
      {activeTab === 'trends' && (
        <div className="space-y-6">
          <div>
            <h2 className="text-title mb-3" style={{ color: 'var(--color-text-1)' }}>Best Customer Quotes</h2>
            {quotes?.length > 0 ? (
              <div className="grid sm:grid-cols-2 gap-3">
                {quotes.map((q, i) => (
                  <div key={i} className="card p-4 space-y-2">
                    <Badge variant="success">{q.category}</Badge>
                    <p className="text-sm leading-relaxed italic" style={{ color: 'var(--color-text-1)', lineHeight: 1.7 }}>
                      "{q.quote}"
                    </p>
                    <p className="text-[10px]" style={{ color: 'var(--color-text-3)' }}>
                      {q.reviewerName || 'Guest'} · {q.locationName} · {'★'.repeat(q.starRating ?? 5)}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm" style={{ color: 'var(--color-text-3)' }}>No standout quotes identified yet.</p>
            )}
          </div>

          <div>
            <h2 className="text-title mb-1" style={{ color: 'var(--color-text-1)' }}>Seasonal Trends</h2>
            <p className="text-xs mb-3" style={{ color: 'var(--color-text-3)' }}>
              Categories whose mention rate is notably higher in a specific month, across your full review history.
              Based on limited samples for some categories — treat as a signal to investigate, not a certainty.
            </p>
            {seasonal?.length > 0 ? (
              <div className="space-y-1.5">
                {seasonal.map((s, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg"
                       style={{ background: 'var(--color-surface-2)' }}>
                    <div className="flex items-center gap-2">
                      <Badge variant={s.type === 'complaint' ? 'danger' : 'success'}>{s.type}</Badge>
                      <span className="text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>{s.name}</span>
                    </div>
                    <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                      Peaks in <strong>{s.peakMonth}</strong> ({s.skew}× typical rate, {s.peakCount}/{s.totalMentions} mentions)
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm" style={{ color: 'var(--color-text-3)' }}>No seasonal patterns detected yet.</p>
            )}
          </div>
        </div>
      )}

    </div>
  )
}
