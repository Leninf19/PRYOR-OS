import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Tabs from '../components/ui/Tabs.jsx'
import Modal from '../components/ui/Modal.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import ErrorState from '../components/ui/ErrorState.jsx'
import { useAccount } from '../components/AuthGate.jsx'
import { useMeta } from '../hooks/useIntelligence.js'
import { useCampaigns, useContentAssets, downloadAsset, printAssetUrl } from '../hooks/useContentLibrary.js'

// Operations Calendar + Content Library milestone -- a clean internal
// marketing portal. Deliberately avoids exposing storage internals (blob,
// asset id, pathname) anywhere in this UI -- see useContentLibrary.js's own
// list-assets response, which never even sends blobPathname to the browser.

const ASSET_TYPE_META = {
  instagram_post:  { icon: '📷', label: 'Instagram Post' },
  facebook_post:   { icon: '👍', label: 'Facebook Post' },
  story_reel:      { icon: '🎬', label: 'Story / Reel' },
  flyer_pdf:       { icon: '📄', label: 'Flyer (PDF)' },
  banner_pdf:      { icon: '📐', label: 'Banner (PDF)' },
  menu_insert:     { icon: '📋', label: 'Menu Insert' },
  website_graphic: { icon: '🌐', label: 'Website Graphic' },
  caption:         { icon: '✏️', label: 'Caption' },
  other:           { icon: '📎', label: 'Other' },
}
const ASSET_TYPES = Object.keys(ASSET_TYPE_META)
const STATUS_VARIANT = { Draft: 'neutral', Approved: 'success', Archived: 'neutral' }

function isPdf(mimeType) { return mimeType === 'application/pdf' }
function isImage(mimeType) { return mimeType?.startsWith('image/') }

function campaignTiming(c) {
  const now = new Date()
  const start = c.startDate ? new Date(c.startDate) : null
  const end = c.endDate ? new Date(c.endDate) : null
  if (end && end < now) return { label: 'Expired', variant: 'neutral' }
  if (start && start > now) return { label: 'Upcoming', variant: 'info' }
  return { label: 'Current', variant: 'success' }
}

function locationLabel(locationIds, metaLocations) {
  if (locationIds === '*') return 'All locations'
  if (!Array.isArray(locationIds) || !metaLocations) return '—'
  const names = locationIds.map(id => metaLocations.find(l => l.locationId === id)?.name).filter(Boolean)
  return names.length ? names.join(', ') : `${locationIds.length} location(s)`
}

// ── Campaign form (create/edit) ──────────────────────────────────────────

// See Calendar.jsx's TaskFormModal for why this is remounted via
// key={initial?.__seed} at the call site rather than trying to re-sync
// `form` from a changed `initial` prop in place -- same fix, same bug class.
function CampaignFormModal({ open, onClose, initial, onSubmit, metaLocations, canApprove, saving, error }) {
  const [form, setForm] = useState(initial)
  if (!form) return null
  const set = (patch) => setForm(f => ({ ...f, ...patch }))
  function toggleLocation(id) {
    // form.locationIds === '*' ("all locations") isn't an array -- expand it
    // to the full explicit list first so toggling one location off narrows
    // the set instead of silently starting from empty (which would have
    // dropped every OTHER location the campaign was actually authorized for).
    const current = form.locationIds === '*'
      ? (metaLocations ?? []).map(l => l.locationId)
      : (Array.isArray(form.locationIds) ? form.locationIds : [])
    set({ locationIds: current.includes(id) ? current.filter(x => x !== id) : [...current, id] })
  }
  function isLocationSelected(id) {
    return form.locationIds === '*' || (Array.isArray(form.locationIds) && form.locationIds.includes(id))
  }
  function submit(e) { e.preventDefault(); onSubmit(form) }

  return (
    <Modal open={open} onClose={onClose} title={initial?.id ? 'Edit Campaign' : 'New Campaign'} size="lg"
           footer={(
             <div className="flex justify-end gap-2">
               <button type="button" onClick={onClose} className="text-sm px-4 py-2 rounded-lg" style={{ color: 'var(--color-text-2)' }}>Cancel</button>
               <button type="submit" form="campaign-form" disabled={saving}
                       className="text-sm font-semibold px-4 py-2 rounded-lg text-white" style={{ background: 'var(--color-accent)', opacity: saving ? 0.6 : 1 }}>
                 {saving ? 'Saving…' : 'Save Campaign'}
               </button>
             </div>
           )}>
      <form id="campaign-form" onSubmit={submit} className="space-y-4">
        {error && <div className="text-xs p-2 rounded-lg" style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}>{error}</div>}
        <div>
          <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Campaign name</label>
          <input required value={form.name ?? ''} onChange={e => set({ name: e.target.value })}
                 className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }} placeholder="Kids Eat Free — Wednesdays" />
        </div>
        <div>
          <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Description</label>
          <textarea value={form.description ?? ''} onChange={e => set({ description: e.target.value })} rows={2}
                    className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Start date</label>
            <input type="date" value={form.startDate ?? ''} onChange={e => set({ startDate: e.target.value })}
                   className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }} />
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>End date</label>
            <input type="date" value={form.endDate ?? ''} onChange={e => set({ endDate: e.target.value })}
                   className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }} />
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Locations</label>
          <div className="flex flex-wrap gap-1.5">
            {(metaLocations ?? []).map(l => (
              <button key={l.locationId} type="button" onClick={() => toggleLocation(l.locationId)}
                      className="text-xs px-2.5 py-1 rounded-full border"
                      style={isLocationSelected(l.locationId)
                        ? { background: 'var(--color-accent-lt)', color: 'var(--color-accent)', borderColor: 'var(--color-accent-md)' }
                        : { color: 'var(--color-text-2)', borderColor: 'var(--color-border)' }}>
                {l.name}
              </button>
            ))}
          </div>
        </div>
        {initial?.id && canApprove && (
          <div>
            <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Status</label>
            <select value={form.status ?? 'Draft'} onChange={e => set({ status: e.target.value })}
                    className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
              <option value="Draft">Draft</option>
              <option value="Approved">Approved</option>
              <option value="Archived">Archived</option>
            </select>
            <p className="text-[10px] mt-1" style={{ color: 'var(--color-text-3)' }}>
              Draft assets are hidden from Location Managers until Approved.
            </p>
          </div>
        )}
      </form>
    </Modal>
  )
}

// ── Upload modal ──────────────────────────────────────────────────────────

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function UploadModal({ open, onClose, campaignId, onUpload, onAddCaption, uploading, error }) {
  const [type, setType] = useState('flyer_pdf')
  const [file, setFile] = useState(null)
  const [captionText, setCaptionText] = useState('')
  const isCaption = type === 'caption'

  async function submit(e) {
    e.preventDefault()
    if (isCaption) {
      await onAddCaption({ campaignId, captionText })
    } else if (file) {
      const fileBase64 = await fileToBase64(file)
      await onUpload({ campaignId, type, filename: file.name, mimeType: file.type, fileBase64 })
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Content" size="sm"
           footer={(
             <div className="flex justify-end gap-2">
               <button type="button" onClick={onClose} className="text-sm px-4 py-2 rounded-lg" style={{ color: 'var(--color-text-2)' }}>Cancel</button>
               <button type="submit" form="upload-form" disabled={uploading}
                       className="text-sm font-semibold px-4 py-2 rounded-lg text-white" style={{ background: 'var(--color-accent)', opacity: uploading ? 0.6 : 1 }}>
                 {uploading ? 'Uploading…' : 'Add'}
               </button>
             </div>
           )}>
      <form id="upload-form" onSubmit={submit} className="space-y-3">
        {error && <div className="text-xs p-2 rounded-lg" style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}>{error}</div>}
        <div>
          <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Type</label>
          <select value={type} onChange={e => setType(e.target.value)}
                  className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
            {ASSET_TYPES.map(t => <option key={t} value={t}>{ASSET_TYPE_META[t].label}</option>)}
          </select>
        </div>
        {isCaption ? (
          <div>
            <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Caption text</label>
            <textarea required value={captionText} onChange={e => setCaptionText(e.target.value)} rows={4}
                      className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }} />
          </div>
        ) : (
          <div>
            <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>File (image or PDF)</label>
            <input required type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                   onChange={e => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
            <p className="text-[10px] mt-1" style={{ color: 'var(--color-text-3)' }}>Images up to 15MB, PDFs up to 50MB.</p>
          </div>
        )}
      </form>
    </Modal>
  )
}

// ── Asset card ────────────────────────────────────────────────────────────

function AssetCard({ asset, onDelete, canManage }) {
  const meta = ASSET_TYPE_META[asset.type] ?? ASSET_TYPE_META.other
  return (
    <Card className="p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-lg" aria-hidden="true">{meta.icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>{meta.label}</p>
          {asset.type !== 'caption' && <p className="text-[10px] truncate" style={{ color: 'var(--color-text-3)' }}>{asset.filename}</p>}
        </div>
      </div>
      {asset.type === 'caption' ? (
        <p className="text-xs italic p-2 rounded-lg" style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}>
          "{asset.captionText}"
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {asset.type === 'caption' ? (
          <button type="button" onClick={() => navigator.clipboard?.writeText(asset.captionText)}
                  className="text-[11px] font-semibold px-2.5 py-1 rounded-lg" style={{ background: 'var(--color-accent-lt)', color: 'var(--color-accent)' }}>
            Copy Caption
          </button>
        ) : (
          <>
            <button type="button" onClick={() => downloadAsset(asset.id, asset.filename)}
                    className="text-[11px] font-semibold px-2.5 py-1 rounded-lg" style={{ background: 'var(--color-accent-lt)', color: 'var(--color-accent)' }}>
              Download
            </button>
            {isPdf(asset.mimeType) && (
              <a href={printAssetUrl(asset.id)} target="_blank" rel="noreferrer"
                 className="text-[11px] font-semibold px-2.5 py-1 rounded-lg" style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}>
                Print
              </a>
            )}
            {isImage(asset.mimeType) && (
              <a href={printAssetUrl(asset.id)} target="_blank" rel="noreferrer"
                 className="text-[11px] font-semibold px-2.5 py-1 rounded-lg" style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}>
                Preview
              </a>
            )}
          </>
        )}
        {canManage && (
          <button type="button" onClick={() => onDelete(asset)}
                  className="text-[11px] font-semibold px-2.5 py-1 rounded-lg" style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}>
            Delete
          </button>
        )}
      </div>
    </Card>
  )
}

// ── Delete campaign confirmation ─────────────────────────────────────────

function DeleteCampaignModal({ open, onClose, onConfirm, deleting, error }) {
  return (
    <Modal open={open} onClose={deleting ? () => {} : onClose} title="Delete campaign?" size="sm"
           footer={(
             <div className="flex justify-end gap-2">
               <button type="button" onClick={onClose} disabled={deleting} className="text-sm px-4 py-2 rounded-lg" style={{ color: 'var(--color-text-2)' }}>
                 Cancel
               </button>
               <button type="button" onClick={onConfirm} disabled={deleting}
                       className="text-sm font-semibold px-4 py-2 rounded-lg text-white" style={{ background: 'var(--color-danger)', opacity: deleting ? 0.6 : 1 }}>
                 {deleting ? 'Deleting…' : 'Delete Campaign'}
               </button>
             </div>
           )}>
      <div className="space-y-3">
        {error && <div className="text-xs p-2 rounded-lg" style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}>{error}</div>}
        <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
          This will permanently remove the campaign and its associated Content Library assets.
        </p>
      </div>
    </Modal>
  )
}

// ── Campaign detail ───────────────────────────────────────────────────────

function CampaignDetail({ campaign, onBack, metaLocations, canManage, canApprove, onEditCampaign, onDeleteCampaign, isDeleting, deleteError }) {
  const { assets, isLoading, isError, uploadAsset, addCaption, deleteAsset, isUploading, uploadError } = useContentAssets(campaign.id)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const timing = campaignTiming(campaign)

  async function handleDownloadAll() {
    // Sequential downloads for V1 -- a ZIP would need a server-side
    // archiving step for no real benefit at this asset-count scale; see
    // the architecture report's documented tradeoff.
    for (const asset of assets.filter(a => a.type !== 'caption')) {
      // eslint-disable-next-line no-await-in-loop
      await downloadAsset(asset.id, asset.filename)
    }
  }

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="text-xs font-medium" style={{ color: 'var(--color-accent)' }}>← All Campaigns</button>
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-title" style={{ color: 'var(--color-text-1)' }}>{campaign.name}</h2>
            <Badge variant={STATUS_VARIANT[campaign.status]}>{campaign.status}</Badge>
            <Badge variant={timing.variant}>{timing.label}</Badge>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-3)' }}>
            {campaign.startDate ?? '—'} – {campaign.endDate ?? '—'} · {locationLabel(campaign.locationIds, metaLocations)}
          </p>
          {campaign.description && <p className="text-sm mt-2" style={{ color: 'var(--color-text-2)' }}>{campaign.description}</p>}
        </div>
        <div className="flex gap-2">
          {canManage && (
            <button type="button" onClick={() => onEditCampaign(campaign)}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg" style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}>
              Edit
            </button>
          )}
          {canManage && (
            <button type="button" onClick={() => setConfirmDeleteOpen(true)}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg" style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}>
              Delete
            </button>
          )}
          {assets.length > 0 && (
            <button type="button" onClick={handleDownloadAll}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg text-white" style={{ background: 'var(--color-accent)' }}>
              Download All
            </button>
          )}
          {canManage && (
            <button type="button" onClick={() => setUploadOpen(true)}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg text-white" style={{ background: 'var(--color-accent)' }}>
              + Add Content
            </button>
          )}
        </div>
      </div>

      {isError ? <ErrorState body="Couldn't load this campaign's assets." /> : isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
      ) : assets.length === 0 ? (
        <EmptyState icon="📁" title="No assets yet" body="Approved marketing materials for this campaign will appear here." />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {assets.map(a => <AssetCard key={a.id} asset={a} onDelete={(asset) => deleteAsset(asset.id)} canManage={canManage} />)}
        </div>
      )}

      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} campaignId={campaign.id}
                   onUpload={async (f) => { await uploadAsset(f); setUploadOpen(false) }}
                   onAddCaption={async (f) => { await addCaption(f); setUploadOpen(false) }}
                   uploading={isUploading} error={uploadError} />

      <DeleteCampaignModal open={confirmDeleteOpen} onClose={() => setConfirmDeleteOpen(false)}
                            onConfirm={() => onDeleteCampaign(campaign)} deleting={isDeleting} error={deleteError} />
    </div>
  )
}

// ── Campaign card ─────────────────────────────────────────────────────────

function CampaignCard({ campaign, onOpen, metaLocations }) {
  const timing = campaignTiming(campaign)
  return (
    <Card className="p-4 cursor-pointer hover:shadow-md transition-shadow" onClick={() => onOpen(campaign)}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <p className="text-sm font-bold truncate" style={{ color: 'var(--color-text-1)' }}>{campaign.name}</p>
        <Badge variant={STATUS_VARIANT[campaign.status]}>{campaign.status}</Badge>
      </div>
      <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>
        {campaign.startDate ?? '—'} – {campaign.endDate ?? '—'}
      </p>
      <p className="text-xs mt-1" style={{ color: 'var(--color-text-2)' }}>{locationLabel(campaign.locationIds, metaLocations)}</p>
      <div className="mt-2"><Badge variant={timing.variant}>{timing.label}</Badge></div>
    </Card>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Content() {
  const account = useAccount()
  const { data: meta } = useMeta()
  const [searchParams, setSearchParams] = useSearchParams()
  const {
    campaigns, isLoading, isError, createCampaign, updateCampaign, isSaving, saveError,
    deleteCampaign, isDeleting, deleteError,
  } = useCampaigns({ includeArchived: true })

  const canManage = ['owner', 'admin', 'marketing'].includes(account?.role)
  const canApprove = canManage

  const [tab, setTab] = useState('campaigns')
  const [selectedCampaign, setSelectedCampaign] = useState(null)
  const [formOpen, setFormOpen] = useState(false)
  const [formSeed, setFormSeed] = useState(null)
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [deleteBanner, setDeleteBanner] = useState(null)

  const deepLinkCampaignId = searchParams.get('campaignId')
  useEffect(() => {
    if (!deepLinkCampaignId || !campaigns.length) return
    const match = campaigns.find(c => c.id === deepLinkCampaignId)
    if (match) setSelectedCampaign(match)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkCampaignId, campaigns.length])

  const visibleCampaigns = useMemo(() => {
    return campaigns.filter(c => {
      if (!showArchived && c.status === 'Archived') return false
      if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [campaigns, showArchived, search])

  function openCreate() { setFormSeed({ __seed: Math.random(), name: '', description: '', startDate: '', endDate: '', locationIds: [] }); setFormOpen(true) }
  // Deliberately does NOT clear selectedCampaign -- the campaign detail view
  // stays open behind the modal, so saving returns the user to where they
  // were instead of dropping them back on the campaigns grid (requirement:
  // "campaign remains selected" after Edit).
  function openEdit(c) { setFormSeed({ __seed: Math.random(), ...c }); setFormOpen(true) }

  async function handleSubmit(form) {
    if (form.id) {
      const { campaign } = await updateCampaign(form.id, form)
      // Refresh the open detail view with the server's own record (never a
      // client-side merge) so an edit is visible immediately without
      // waiting on the list query's own refetch.
      setSelectedCampaign(campaign)
    } else {
      await createCampaign(form)
    }
    setFormOpen(false)
  }

  async function handleDeleteCampaign(campaign) {
    const result = await deleteCampaign(campaign.id)
    setSelectedCampaign(null)
    if (searchParams.get('campaignId')) {
      const next = new URLSearchParams(searchParams)
      next.delete('campaignId')
      setSearchParams(next, { replace: true })
    }
    setDeleteBanner(result?.partial ? result.message : null)
  }

  if (isError) return <ErrorState body="Couldn't load the content library." />

  if (selectedCampaign) {
    return (
      <div className="max-w-[1200px]">
        <CampaignDetail campaign={selectedCampaign} onBack={() => setSelectedCampaign(null)} metaLocations={meta?.locations}
                         canManage={canManage} canApprove={canApprove} onEditCampaign={openEdit}
                         onDeleteCampaign={handleDeleteCampaign} isDeleting={isDeleting} deleteError={deleteError} />
        <CampaignFormModal key={formSeed?.__seed ?? 'empty'} open={formOpen} onClose={() => setFormOpen(false)} initial={formSeed} onSubmit={handleSubmit}
                            metaLocations={meta?.locations} canApprove={canApprove} saving={isSaving} error={saveError} />
      </div>
    )
  }

  return (
    <div className="space-y-5 max-w-[1200px]">
      {deleteBanner && (
        <div className="text-xs p-3 rounded-lg flex items-start justify-between gap-3" style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}>
          <span>{deleteBanner}</span>
          <button type="button" onClick={() => setDeleteBanner(null)} className="font-semibold shrink-0">Dismiss</button>
        </div>
      )}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Content</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>Approved marketing materials, organized by campaign</p>
        </div>
        {canManage && (
          <button type="button" onClick={openCreate} className="text-sm font-semibold px-4 py-2 rounded-lg text-white" style={{ background: 'var(--color-accent)' }}>
            + New Campaign
          </button>
        )}
      </div>

      <Tabs tabs={[{ id: 'campaigns', label: 'Campaigns' }, { id: 'assets', label: 'All Assets' }]} value={tab} onChange={setTab} />

      <div className="flex flex-wrap gap-2 items-center">
        <input placeholder="Search campaigns…" value={search} onChange={e => setSearch(e.target.value)}
               className="text-sm px-3 py-1.5 rounded-lg border" style={{ borderColor: 'var(--color-border)' }} />
        {canManage && (
          <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-text-2)' }}>
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
            Show archived
          </label>
        )}
      </div>

      {tab === 'campaigns' ? (
        isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">{[1, 2, 3].map(i => <Skeleton key={i} className="h-32 rounded-xl" />)}</div>
        ) : visibleCampaigns.length === 0 ? (
          <EmptyState icon="🎉" title="No campaigns yet" body="Create a campaign to start organizing approved marketing materials." />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {visibleCampaigns.map(c => <CampaignCard key={c.id} campaign={c} onOpen={setSelectedCampaign} metaLocations={meta?.locations} />)}
          </div>
        )
      ) : (
        <AllAssetsTab campaigns={visibleCampaigns} onOpenCampaign={setSelectedCampaign} />
      )}

      <CampaignFormModal key={formSeed?.__seed ?? 'empty'} open={formOpen} onClose={() => setFormOpen(false)} initial={formSeed} onSubmit={handleSubmit}
                          metaLocations={meta?.locations} canApprove={canApprove} saving={isSaving} error={saveError} />
    </div>
  )
}

function AllAssetsTab({ campaigns, onOpenCampaign }) {
  const { assets, isLoading, isError } = useContentAssets()
  const [type, setType] = useState('')

  const filtered = useMemo(() => (assets ?? []).filter(a => !type || a.type === type), [assets, type])
  const campaignById = useMemo(() => Object.fromEntries(campaigns.map(c => [c.id, c])), [campaigns])

  if (isError) return <ErrorState body="Couldn't load assets." />
  if (isLoading) return <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>

  return (
    <div className="space-y-3">
      <select value={type} onChange={e => setType(e.target.value)} className="text-xs px-2 py-1.5 rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
        <option value="">All types</option>
        {ASSET_TYPES.map(t => <option key={t} value={t}>{ASSET_TYPE_META[t].label}</option>)}
      </select>
      {filtered.length === 0 ? (
        <EmptyState icon="📁" title="No assets found" body="Try a different filter." />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {filtered.map(a => (
            <div key={a.id} onClick={() => campaignById[a.campaignId] && onOpenCampaign(campaignById[a.campaignId])} className="cursor-pointer">
              <AssetCard asset={a} onDelete={() => {}} canManage={false} />
              <p className="text-[10px] mt-1 truncate" style={{ color: 'var(--color-text-3)' }}>{campaignById[a.campaignId]?.name ?? ''}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
