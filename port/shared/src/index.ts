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
