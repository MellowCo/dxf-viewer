import { BatchingKey } from "./BatchingKey.js"
import { DxfWorker } from "./DxfWorker.js"
import { ColorCode, DxfScene } from "./DxfScene.js"
import { RBTree } from "./RBTree.js"

import mainFont from "./fonts/Roboto-LightItalic.ttf"
import aux1Font from "./fonts/NotoSansDisplay-SemiCondensedLightItalic.ttf"
import aux2Font from "./fonts/HanaMinA.ttf"
import aux3Font from "./fonts/NanumGothic-Regular.ttf"


export class DxfParser {
  /**
   * 
   */
  options = DxfParser.DefaultOptions

  /**
   * Indexed by MaterialKey, value is {key, material}.
   */
  materials = new RBTree((m1, m2) => m1.key.Compare(m2.key))

  /**
   * Indexed by layer name, value is Layer instance
   */
  layers = new Map()

  /**
   * Default layer used when no layer specified
   */
  defaultLayer = null

  /**
   * Indexed by block name, value is Block instance
   */
  blocks = new Map()

  /**
   * Set during data loading
   */
  worker = null

  entities = []

  /** @param domContainer Container element to create the canvas in. Usually empty div. Should not
   *  have padding if auto-resize feature is used.
   * @param options Some options can be overridden if specified. See DxfParser.DefaultOptions.
   */
  constructor(options) {
    if (options) {
      this.options = { ...this.options, ...options }
    }
    this.clearColor = this.options.clearColor
  }

  GetDxf() {
    return this.parsedDxf
  }

  /** Load DXF into the viewer. Old content is discarded, state is reset.
   * @param url {string} DXF file URL.
   * @param fonts {?string[]} List of font URLs. Files should have typeface.js format. Fonts are
   *  used in the specified order, each one is checked until necessary glyph is found. Text is not
   *  rendered if fonts are not specified.
   * @param progressCbk {?Function} (phase, processedSize, totalSize)
   *  Possible phase values:
   *  * "font"
   *  * "fetch"
   *  * "parse"
   *  * "prepare"
   * @param workerFactory {?Function} Factory for worker creation. The worker script should
   *  invoke DxfParser.SetupWorker() function.
   */
  async Load({ url, fonts = [mainFont, aux1Font, aux2Font, aux3Font], progressCbk = null, workerFactory = null }) {
    if (url === null || url === undefined) {
      throw new Error("`url` parameter is not specified")
    }

    this.Clear()

    this.worker = new DxfWorker(workerFactory ? workerFactory() : null)
    const { scene, dxf } = await this.worker.Load(url, fonts, this.options, progressCbk)
    await this.worker.Destroy()
    this.worker = null
    this.parsedDxf = dxf

    this.origin = scene.origin
    this.bounds = scene.bounds
    this.hasMissingChars = scene.hasMissingChars

    for (const layer of scene.layers) {
      this.layers.set(layer.name, new Layer(layer.name, layer.displayName, layer.color))
    }
    this.defaultLayer = this.layers.get("0") ?? new Layer("0", "0", 0)

    /* Load all blocks on the first pass. */
    for (const batch of scene.batches) {
      if (batch.key.blockName !== null &&
        batch.key.geometryType !== BatchingKey.GeometryType.BLOCK_INSTANCE &&
        batch.key.geometryType !== BatchingKey.GeometryType.POINT_INSTANCE) {

        let block = this.blocks.get(batch.key.blockName)
        if (!block) {
          block = new Block()
          this.blocks.set(batch.key.blockName, block)
        }
        block.PushBatch(new Batch(this, scene, batch))
      }
    }

    /* Instantiate all entities. */
    for (const batch of scene.batches) {
      this._LoadBatch(scene, batch)
    }
  }

  /** @return {Iterable<{name:String, color:number}>} List of layer names. */
  GetLayers() {
    const result = []
    for (const lyr of this.layers.values()) {
      result.push({
        name: lyr.name,
        displayName: lyr.displayName,
        color: this._TransformColor(lyr.color)
      })
    }
    return result
  }

  /** Reset the viewer state. */
  Clear() {
    if (this.worker) {
      this.worker.Destroy(true)
      this.worker = null
    }
    if (this.controls) {
      this.controls.dispose()
      this.controls = null
    }
    for (const layer of this.layers.values()) {
      layer.Dispose()
    }
    this.layers.clear()
    this.blocks.clear()
    this.materials.each(e => e.material.dispose())
    this.materials.clear()
  }

  /** @return {Vector2} Scene origin in global drawing coordinates. */
  getOrigin() {
    return this.origin
  }

  /**
   * @return {?{maxX: number, maxY: number, minX: number, minY: number}} Scene bounds in model
   *      space coordinates. Null if empty scene.
   */
  getBounds() {
    return this.bounds
  }

  getEntities() {
    return this.entities
  }

  // /////////////////////////////////////////////////////////////////////////////////////////////
  _LoadBatch(scene, batch) {
    if (batch.key.blockName !== null &&
      batch.key.geometryType !== BatchingKey.GeometryType.BLOCK_INSTANCE &&
      batch.key.geometryType !== BatchingKey.GeometryType.POINT_INSTANCE) {
      /* Block definition. */
      return
    }
    const objects = new Batch(this, scene, batch).CreateObjects()

    for (const obj of objects) {
      this.entities.push(obj)
      const layer = obj._dxfViewerLayer ?? this.defaultLayer
      layer.PushObject(obj)
    }
  }

  /** Ensure the color is contrast enough with current background color.
   * @param color {number} RGB value.
   * @return {number} RGB value to use for rendering.
   */
  _TransformColor(color) {
    if (!this.options.colorCorrection && !this.options.blackWhiteInversion) {
      return color
    }
    /* Just black and white inversion. */
    const bkgLum = Luminance(this.clearColor)
    if (color === 0xffffff && bkgLum >= 0.8) {
      return 0
    }
    if (color === 0 && bkgLum <= 0.2) {
      return 0xffffff
    }
    if (!this.options.colorCorrection) {
      return color
    }
    const fgLum = Luminance(color)
    const MIN_TARGET_RATIO = 1.5
    const contrast = ContrastRatio(color, this.clearColor)
    const diff = contrast >= 1 ? contrast : 1 / contrast
    if (diff < MIN_TARGET_RATIO) {
      let targetLum
      if (bkgLum > 0.5) {
        targetLum = bkgLum / 2
      } else {
        targetLum = bkgLum * 2
      }
      if (targetLum > fgLum) {
        color = Lighten(color, targetLum / fgLum)
      } else {
        color = Darken(color, fgLum / targetLum)
      }
    }
    return color
  }
}


DxfParser.DefaultOptions = {
  /** Simpler version of colorCorrection - just invert pure white or black entities if they are
   * invisible on current background color.
   */
  blackWhiteInversion: true,

  /** Correct entities colors to ensure that they are always visible with the current background
     * color.
     */
  colorCorrection: false,

  /** Frame buffer clear color. */
  clearColor: 16777215,

  /** Scene generation options. */
  sceneOptions: DxfScene.DefaultOptions,

  /** Retain the simple object representing the parsed DXF - will consume a lot of additional
   * memory.
   */
  retainParsedDxf: false,

  /** Whether to preserve the buffers until manually cleared or overwritten. */
  preserveDrawingBuffer: false,

  /** Encoding to use for decoding DXF file text content. DXF files newer than DXF R2004 (AC1018)
   * use UTF-8 encoding. Older files use some code page which is specified in $DWGCODEPAGE header
   * variable. Currently parser is implemented in such a way that encoding must be specified
   * before the content is parsed so there is no chance to use this variable dynamically. This may
   * be a subject for future changes. The specified value should be suitable for passing as
   * `TextDecoder` constructor `label` parameter.
   */
  fileEncoding: "utf-8"
}

DxfParser.SetupWorker = function () {
  new DxfWorker(self, true)
}

const InstanceType = Object.freeze({
  /** Not instanced. */
  NONE: 0,
  /** Full affine transform per instance. */
  FULL: 1,
  /** Point instances, 2D-translation vector per instance. */
  POINT: 2,

  /** Number of types. */
  MAX: 3
})

class Batch {
  /**
   * @param {DxfParser} viewer
   * @param scene Serialized scene.
   * @param batch Serialized scene batch.
   */
  constructor(viewer, scene, batch) {
    this.viewer = viewer
    this.key = batch.key
    this.batch = batch

    if (batch.hasOwnProperty("verticesOffset")) {
      const verticesArray =
        new Float32Array(scene.vertices,
          batch.verticesOffset * Float32Array.BYTES_PER_ELEMENT,
          batch.verticesSize)

      if (this.key.geometryType !== BatchingKey.GeometryType.POINT_INSTANCE ||
        scene.pointShapeHasDot) {
        this.vertices = verticesArray
      }

      if (this.key.geometryType === BatchingKey.GeometryType.POINT_INSTANCE) {
        this.transforms = verticesArray
      }
    }

    if (batch.hasOwnProperty("chunks")) {
      this.chunks = []
      for (const rawChunk of batch.chunks) {

        const verticesArray =
          new Float32Array(scene.vertices,
            rawChunk.verticesOffset * Float32Array.BYTES_PER_ELEMENT,
            rawChunk.verticesSize)
        const indicesArray =
          new Uint16Array(scene.indices,
            rawChunk.indicesOffset * Uint16Array.BYTES_PER_ELEMENT,
            rawChunk.indicesSize)
        this.chunks.push({
          vertices: verticesArray,
          indices: indicesArray
        })
      }
    }

    this.layer = this.key.layerName !== null ? this.viewer.layers.get(this.key.layerName) : null
  }

  GetInstanceType() {
    switch (this.key.geometryType) {
      case BatchingKey.GeometryType.BLOCK_INSTANCE:
        return InstanceType.FULL
      case BatchingKey.GeometryType.POINT_INSTANCE:
        return InstanceType.POINT
      default:
        return InstanceType.NONE
    }
  }

  /** Create scene objects corresponding to batch data.
   * @param {?Batch} instanceBatch Batch with instance transform. Null for non-instanced object.
   */
  *CreateObjects(instanceBatch = null) {
    if (this.key.geometryType === BatchingKey.GeometryType.BLOCK_INSTANCE ||
      this.key.geometryType === BatchingKey.GeometryType.POINT_INSTANCE) {

      if (instanceBatch !== null) {
        throw new Error("Unexpected instance batch specified for instance batch")
      }
      yield* this._CreateBlockInstanceObjects()
      return
    }
    yield* this._CreateObjects(instanceBatch)
  }


  *_CreateObjects(instanceBatch) {
    let color = instanceBatch ?
      instanceBatch._GetInstanceColor(this) : this.key.color
    color = this.viewer._TransformColor(color)

    /* INSERT layer (if specified) takes precedence over layer specified in block definition. */
    const layer = instanceBatch?.layer ?? this.layer
    const geometryType = this.key.geometryType

    const block = this.batch.key.block
    const parentBlock = this.batch.key.parentBlock


    function CreateObject(vertices, indices) {
      let points = []

      for (let i = 0; i < vertices.length; i = i + 2) {
        points.push({
          x: vertices[i],
          y: vertices[i + 1]
        })
      }

      if (indices) {
        const newPoints = []
        indices.forEach(index => {
          newPoints.push(points[index])
        })
        points = newPoints
      }

      return {
        vertices: points,
        color,
        layer: layer.name,
        geometryType,
        block,
        parentBlock,
      }
    }

    if (this.chunks) {
      for (const chunk of this.chunks) {
        yield CreateObject(chunk.vertices, chunk.indices)
      }
    } else {
      yield CreateObject(this.vertices)
    }
  }


  *_CreateBlockInstanceObjects() {
    const block = this.viewer.blocks.get(this.key.blockName)
    if (!block) {
      return
    }
    for (const batch of block.batches) {
      yield* batch.CreateObjects(this)
    }
    if (this.vertices) {
      /* Dots for point shapes. */
      yield* this._CreateObjects()
    }
  }

  /**
   * @param {Batch} blockBatch Block definition batch.
   * @return {number} RGB color value for a block instance.
   */
  _GetInstanceColor(blockBatch) {
    const defColor = blockBatch.key.color
    if (defColor === ColorCode.BY_BLOCK) {
      return this.key.color
    } else if (defColor === ColorCode.BY_LAYER) {
      if (blockBatch.layer) {
        return blockBatch.layer.color
      }
      return this.layer ? this.layer.color : 0
    }
    return defColor
  }
}

class Layer {
  constructor(name, displayName, color) {
    this.name = name
    this.displayName = displayName
    this.color = color
    this.objects = []
  }

  PushObject(obj) {
    this.objects.push(obj)
  }

  Dispose() {
    this.objects = []
  }
}

class Block {
  constructor() {
    this.batches = []
  }

  /** @param batch {Batch} */
  PushBatch(batch) {
    this.batches.push(batch)
  }
}

/** Transform sRGB color component to linear color space. */
function LinearColor(c) {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** Transform linear color component to sRGB color space. */
function SRgbColor(c) {
  return c < 0.003 ? c * 12.92 : Math.pow(c, 1 / 2.4) * 1.055 - 0.055
}

/** Get relative luminance value for a color.
 * https://www.w3.org/TR/2008/REC-WCAG20-20081211/#relativeluminancedef
 * @param color {number} RGB color value.
 * @return {number} Luminance value in range [0; 1].
 */
function Luminance(color) {
  const r = LinearColor(((color & 0xff0000) >>> 16) / 255)
  const g = LinearColor(((color & 0xff00) >>> 8) / 255)
  const b = LinearColor((color & 0xff) / 255)

  return r * 0.2126 + g * 0.7152 + b * 0.0722
}

/**
 * Get contrast ratio for a color pair.
 * https://www.w3.org/TR/2008/REC-WCAG20-20081211/#contrast-ratiodef
 * @param c1
 * @param c2
 * @return {number} Contrast ratio between the colors. Greater than one if the first color color is
 *  brighter than the second one.
 */
function ContrastRatio(c1, c2) {
  return (Luminance(c1) + 0.05) / (Luminance(c2) + 0.05)
}

function HlsToRgb({ h, l, s }) {
  let r, g, b
  if (s === 0) {
    /* Achromatic */
    r = g = b = l
  } else {
    function hue2rgb(p, q, t) {
      if (t < 0) {
        t += 1
      }
      if (t > 1) {
        t -= 1
      }
      if (t < 1 / 6) {
        return p + (q - p) * 6 * t
      }
      if (t < 1 / 2) {
        return q
      }
      if (t < 2 / 3) {
        return p + (q - p) * (2 / 3 - t) * 6
      }
      return p
    }

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
  }

  return (Math.min(Math.floor(SRgbColor(r) * 256), 255) << 16) |
    (Math.min(Math.floor(SRgbColor(g) * 256), 255) << 8) |
    Math.min(Math.floor(SRgbColor(b) * 256), 255)
}

function RgbToHls(color) {
  const r = LinearColor(((color & 0xff0000) >>> 16) / 255)
  const g = LinearColor(((color & 0xff00) >>> 8) / 255)
  const b = LinearColor((color & 0xff) / 255)

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h, s
  const l = (max + min) / 2

  if (max === min) {
    /* Achromatic */
    h = s = 0
  } else {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0)
        break;
      case g:
        h = (b - r) / d + 2
        break
      case b:
        h = (r - g) / d + 4
        break
    }
    h /= 6
  }

  return { h, l, s }
}

function Lighten(color, factor) {
  const hls = RgbToHls(color)
  hls.l *= factor
  if (hls.l > 1) {
    hls.l = 1
  }
  return HlsToRgb(hls)
}

function Darken(color, factor) {
  const hls = RgbToHls(color)
  hls.l /= factor
  return HlsToRgb(hls)
}
