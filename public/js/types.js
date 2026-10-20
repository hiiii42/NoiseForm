// @ts-check
/**
 * Shared contracts describe current runtime objects; no fields are added at runtime.
 * @typedef {object} Character
 * @property {string} id
 * @property {string} prompt
 * @property {string} uc
 * @property {number} x
 * @property {number} y
 * @property {boolean} enabled
 */
/**
 * @typedef {object} Params
 * @property {string} model
 * @property {string} prompt
 * @property {string} uc
 * @property {number} ucPreset
 * @property {boolean} qualityToggle
 * @property {number} qualityPreset
 * @property {boolean} transparent
 * @property {Character[]} characters
 * @property {boolean} aiChoice
 * @property {number} width
 * @property {number} height
 * @property {string} sizePreset
 * @property {number} nSamples
 * @property {number} steps
 * @property {number} scale
 * @property {number} cfgRescale
 * @property {string|number} seed Editor drafts use strings, resolved snapshots use numbers.
 * @property {boolean} seedLocked
 * @property {string} sampler
 * @property {string} noiseSchedule
 * @property {boolean} variety
 * @property {boolean} smea
 * @property {boolean} dyn
 * @property {boolean} decrisp
 * @property {boolean} normalizeVibes
 */
/**
 * @typedef {object} Settings
 * @property {string} token
 * @property {'auto'|'direct'|'proxy'} conn
 * @property {string} theme
 * @property {string} fontScale
 * @property {'zh'|'en'} lang
 * @property {boolean} fxReveal
 * @property {boolean} fxBg
 * @property {boolean} stream
 * @property {boolean} translate
 * @property {boolean} spellcheck
 * @property {boolean} reviewOpen
 * @property {boolean} archWide
 * @property {number} archW
 * @property {number} archSize
 * @property {boolean} autoSave
 * @property {boolean} warnDuplicate
 * @property {'loop'|'change'} autoMode
 * @property {number} autoCount Zero means unbounded batch.
 * @property {boolean} autoFreeOnly
 * @property {boolean} queueSeedPrev
 * @property {{base: string, key: string, model: string, route: string, think?: boolean, models?: string[]}} llm
 * @property {boolean} notify
 * @property {boolean} artistPeek
 * @property {boolean} promptFormat
 * @property {{vibe: boolean, ref: boolean, base: boolean}} collapsed
 */
/**
 * @typedef {object} BaseImage
 * @property {string} image Data URL.
 * @property {number} width
 * @property {number} height
 * @property {number} strength
 * @property {number} noise
 * @property {string|null} [mask]
 * @property {string} [sourceId]
 * @property {string} [id]
 */
/** @typedef {{id: string, image: string, ie: number, strength: number, enabled: boolean, enc?: Record<string,string>}} Vibe */
/** @typedef {{id: string, image: string, type: string, strength: number, fidelity: number}} PreciseReference */
/**
 * One row of data.MODELS. Capability flags are optional: absent = false.
 * @typedef {object} Model
 * @property {string} id
 * @property {string} name
 * @property {string} short
 * @property {string} [desc] @property {string} [tag] @property {string} [group]
 * @property {boolean} [v3] @property {boolean} [v4] @property {boolean} [v45] @property {boolean} [v5]
 * @property {boolean} [full] @property {boolean} [furry] @property {boolean} [vibes] @property {boolean} [refs]
 * @property {boolean} [forceKarras] @property {boolean} [noRescale] @property {boolean} [forcedUC]
 * @property {boolean} [qualityPresets] @property {boolean} [transparency]
 * @property {number} [maxChars] @property {number} [tokenLimit] @property {number} [costMul] @property {number} [costK] @property {number} [vibeIE]
 * @property {number|null} [varietyBase]
 * @property {string} [inpaint] @property {string} [fallback] @property {string} [suggestType] @property {string} [suggestModel]
 * @property {{steps?: number, sampler?: string}} [fixed] parameter values the model forces
 */
/**
 * Input accepted by domain/cost and queue item contexts. In generationContext,
 * params is copied, chunk-expanded and resolved before the first await.
 * @typedef {object} GenerationSpec
 * @property {Params} params
 * @property {BaseImage|null} [base]
 * @property {Vibe[]} [vibes]
 * @property {PreciseReference[]} [refs]
 * @property {number} [nSamples]
 * @property {'zh'|'en'} [lang]
 */
/** @typedef {{identity: 'browser-token'|'server-token'|'demo', token: string, mode: string, proxy: boolean, resolved: string|null}} ConnectionContext */
/** @typedef {{tier: number|null, active?: boolean, freeBlocked?: boolean, usageNegative?: boolean, live?: boolean}} AccountContext */
/**
 * Runtime execution object from app/generate.js. Cancellation and correlation
 * IDs are not yet stored on this object, so they are not declared here.
 * @typedef {{connection: ConnectionContext, account: AccountContext, live: boolean, stream: boolean}} ExecutionContext
 */
/** @typedef {'queued'|'running'|'paused'|'done'|'stopped'|'failed'} JobStatus */
/**
 * queued/paused -> running -> paused/done/failed; ending an active or queued
 * job gives stopped. Persist/unknown/compose failures pause, never regenerate.
 * History entries are lean: snap retains only params; cells are omitted.
 * @typedef {object} JobCommon
 * @property {string} id
 * @property {number} no
 * @property {number} createdAt
 * @property {JobStatus} status
 * @property {number} done
 * @property {number[]} seeds
 * @property {string[]} recs
 * @property {GenerationSpec} snap
 * @property {boolean} freeOnly
 * @property {number} count
 * @property {number} [finishedAt]
 * @property {number} [startedAt]
 * @property {string} [reason]
 * @property {boolean} [pauseAfter]
 * @property {string} [pendingSaveId] Points to memory-only recovery, not a durable Blob.
 * @property {'tiles'|'compose'|'persist'|'unknown'|'done'} [stage]
 * @property {number[]|null} [srcSeeds]
 * @property {number|null} [srcNo]
 * @property {unknown} [result]
 */
/** @typedef {JobCommon & {kind: 'batch', seedMode: 'fixed'|'prev'|'job'|'random', seedFrom: string|null}} BatchJob */
/** @typedef {JobCommon & {kind: 'oneoff', count: 1, seedMode: 'fixed'|'random'}} OneoffJob */
/** @typedef {{key: string, seed: number, params: Params, x?: number, y?: number}} XYCell */
/** @typedef {XYCell & {base: BaseImage}} TiledCell */
/** @typedef {JobCommon & {kind: 'xy', seedMode: 'grid', gridId: string, cells: XYCell[], label: string}} XYJob */
/**
 * meta is the opaque persisted plan consumed by ui/tiled.finalizeTiledJob;
 * it is intentionally not guessed here. Legacy jobs may carry null.
 * @typedef {JobCommon & {kind: 'tiled', seedMode: 'grid', tiledId: string, cells: TiledCell[], label: string, meta: object|null}} TiledJob
 */
/** @typedef {BatchJob|OneoffJob|XYJob|TiledJob} Job */
/** @typedef {Omit<XYJob,'cells'|'gridId'> & {cells?: undefined, gridId?: string}} XYHistoryJob */
/** @typedef {Omit<TiledJob,'cells'|'tiledId'> & {cells?: undefined, tiledId?: string}} TiledHistoryJob */
/** @typedef {{seq: number, jobs: Job[], history: (BatchJob|XYHistoryJob|TiledHistoryJob)[]}} QueueData */
/**
 * The existing rec.saved marker. Folder identity is currently its display name;
 * the actual directory handle lives at kv saveDir. Browser/ZIP markers record
 * download initiation rather than filesystem readback or a content checksum.
 * @typedef {{at: number, name: string, via: 'folder'|'download'|'zip'|'manual', dir?: string}} SavedArtifact
 */
/**
 * @typedef {object} ArchiveRecord
 * @property {string} id
 * @property {number} no
 * @property {number} createdAt
 * @property {string|null} batchId
 * @property {Blob} blob
 * @property {Blob} [thumb]
 * @property {number} width
 * @property {number} height
 * @property {number} [seed]
 * @property {string} [model]
 * @property {string} kind
 * @property {Params} [params]
 * @property {boolean} [demo]
 * @property {string} [sourceId]
 * @property {string} [baseImage]
 * @property {SavedArtifact} [saved]
 * @property {-1|0|1} [flag]
 * @property {object} [post]
 * @property {object} [tiled]
 * @property {{grid: string, x: number, y: number}} [xy]
 * @property {{id: string, no: number}} [job]
 * @property {{mode: string, connection: string, baseId: string|null, refs: string[], vibes: string[]}} [generation]
 */
/**
 * Existing pendingSaves entry: items retain Blobs after an archive write failure.
 * items[].createdAt is generation completion time; persistence adds thumbnails.
 * @typedef {object} GeneratedArtifact
 * @property {string} id
 * @property {'received'|'persist'|'persisted'} stage
 * @property {boolean} queued
 * @property {ArchiveRecord[]} items
 * @property {GenerationSpec & {model: object, cost: object, execution: ExecutionContext}} context
 * @property {object} options
 * @property {boolean} [select]
 * @property {Promise<object>|null} [saving]
 * @property {{ok: true, stage: 'persisted', recs: ArchiveRecord[]}} [result]
 */
/**
 * v0 = legacy unwrapped payload; current business schema v1. Invalid input is
 * copied verbatim to key.bak-<timestamp>-<sequence> before replacing with defaults.
 * Queue revision is a write counter (not the schema version).
 * @template T
 * @typedef {object} PersistedEnvelope
 * @property {number} v
 * @property {T} data
 * @property {number} [revision]
 * @property {number} [updatedAt]
 * @property {string} [writer]
 * @property {string|null} [runner]
 */
/** @typedef {{ok: true, stage: 'persisted', recs: ArchiveRecord[]}} GenerationOK */
/** @typedef {{ok: false, skipped: true}} GenerationSkipped */
/** A persistence failure must only retry saving the retained artifact, never generation.
 * @typedef {{ok: false, stage: 'persist', pendingId: string, err: Error}} GenerationPersistFailure
 */
/** Unknown results currently use stage=request plus err.unknown; there is no stage=unknown return.
 * @typedef {{ok: false, stage: 'request', err: Error & {unknown: true}}} GenerationUnknownFailure
 */
/** @typedef {{ok: false, stage: 'request', err: Error & {unknown?: false}}} GenerationRequestFailure */
/** @typedef {GenerationOK|GenerationSkipped|GenerationPersistFailure|GenerationUnknownFailure|GenerationRequestFailure} GenerationResult */
