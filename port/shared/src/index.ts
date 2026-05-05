// Public barrel for @minigolf/shared.

export { Seed } from "./seed.ts";

export {
    PacketType,
    type Packet,
    bool,
    parseBool,
    buildData,
    buildCommand,
    encode,
    decode,
} from "./protocol.ts";

export {
    TILE_WIDTH,
    TILE_HEIGHT,
    decodeMap,
    unpackTile,
    expandRle,
    type UnpackedTile,
} from "./rle.ts";

export {
    type Track,
    type TrackSet,
    type TrackSetDifficulty,
    type SettingsFlags,
    NO_SETTINGS_FLAGS,
    ALL_VISIBLE_FLAGS,
    parseTrack,
    parseTrackset,
    parseSettingsFlags,
    applySettingsToTileCode,
} from "./track.ts";

export {
    PIXEL_PER_TILE,
    MAP_PIXEL_WIDTH,
    MAP_PIXEL_HEIGHT,
    TILE,
    getFriction,
    calculateFriction,
    getYPixelsFromSpecialId,
} from "./tiles.ts";

export { type ToolsArg, izer, tabularize, triangelize, commaize } from "./tools.ts";

export {
    type BallSnapshotEntry,
    SNAP_FLAG_STOPPED,
    SNAP_FLAG_IN_HOLE,
    SNAP_FLAG_ON_HOLE,
    SNAP_FLAG_ON_LIQUID,
    SNAP_FLAG_TELEPORTED,
    SNAP_FLAG_CAUSED_BY_SHOT,
    encodeBallSnapshot,
    decodeBallSnapshot,
    ballPosDistSq,
    SNAPSHOT_AGREEMENT_EPSILON_PX,
} from "./snapshot.ts";

export {
    resolveSnapshots,
    type SnapshotReport,
    type ResolutionResult,
    type PhysicsTiebreaker,
} from "./snap-resolver.ts";
