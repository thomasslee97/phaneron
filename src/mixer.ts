/*
  Phaneron - Clustered, accelerated and cloud-fit video server, pre-assembled and in kit form.
  Copyright (C) 2020 Streampunk Media Ltd.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
  https://www.streampunk.media/ mailto:furnace@streampunk.media
  14 Ormiscaig, Aultbea, Achnasheen, IV22 2JJ  U.K.
*/

import { clContext as nodenCLContext, OpenCLBuffer } from 'nodencl'
import { RedioPipe, RedioEnd, isValue, Valve, nil } from 'redioactive'
import { Frame, Filterer, filterer } from 'beamcoder'
import { VideoFormat } from './config'
import { ClJobs } from './clJobQueue'
import ImageProcess from './process/imageProcess'
import Transform from './process/transform'

interface AnchorParams {
	x: number
	y: number
}

interface FillParams {
	xOffset: number
	yOffset: number
	xScale: number
	yScale: number
}

export class Mixer {
	private readonly clContext: nodenCLContext
	private readonly srcFormat: VideoFormat
	private readonly consumerFormat: VideoFormat
	private transform: ImageProcess | null
	// private black: OpenCLBuffer | null = null
	private mixAudio: RedioPipe<Frame | RedioEnd> | undefined
	private mixVideo: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private audMixFilterer: Filterer | null = null

	anchorParams: AnchorParams = { x: 0, y: 0 }
	rotation = 0
	fillParams: FillParams = { xOffset: 0, yOffset: 0, xScale: 1, yScale: 1 }
	volume = 1.0

	constructor(
		clContext: nodenCLContext,
		srcFormat: VideoFormat,
		consumerFormat: VideoFormat,
		clJobs: ClJobs
	) {
		this.clContext = clContext
		this.srcFormat = srcFormat
		this.consumerFormat = consumerFormat
		this.transform = new ImageProcess(
			this.clContext,
			new Transform(this.clContext, this.srcFormat.width, this.srcFormat.height),
			clJobs
		)
	}

	async init(
		srcAudio: RedioPipe<Frame | RedioEnd>,
		srcVideo: RedioPipe<OpenCLBuffer | RedioEnd>
	): Promise<void> {
		const sampleRate = this.srcFormat.audioSampleRate
		const numAudChannels = this.srcFormat.audioChannels
		const audLayout = `${numAudChannels}c`
		this.audMixFilterer = await filterer({
			filterType: 'audio',
			inputParams: [
				{
					name: 'in0:a',
					timeBase: [1, sampleRate],
					sampleRate: sampleRate,
					sampleFormat: 'flt',
					channelLayout: audLayout
				}
			],
			outputParams: [
				{
					name: 'out0:a',
					sampleRate: sampleRate,
					sampleFormat: 'flt',
					channelLayout: audLayout
				}
			],
			filterSpec: `[in0:a] volume=1.0:eval=frame:precision=float [out0:a]`
		})
		// console.log('\nMixer audio:\n', this.audMixFilterer.graph.dump())

		const audMixFilter: Valve<Frame | RedioEnd, Frame | RedioEnd> = async (frame) => {
			if (isValue(frame) && this.audMixFilterer) {
				const ff = await this.audMixFilterer.filter([{ name: 'in0:a', frames: [frame] }])
				return ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				this.audMixFilterer = null
				return frame
			}
		}

		await this.transform?.init()
		const numBytesRGBA = this.consumerFormat.width * this.consumerFormat.height * 4 * 4
		const srcXscale = this.consumerFormat.squareWidth / this.srcFormat.squareWidth
		const srcYscale = this.consumerFormat.squareHeight / this.srcFormat.squareHeight

		// this.black = await this.clContext.createBuffer(
		// 	numBytesRGBA,
		// 	'readwrite',
		// 	'coarse',
		// 	{
		// 		width: this.width,
		// 		height: this.height
		// 	},
		// 	'mixer'
		// )

		// let off = 0
		// const blackFloat = new Float32Array(this.width * this.height * 4)
		// for (let y = 0; y < this.height; ++y) {
		// 	for (let x = 0; x < this.width * 4; x += 4) {
		// 		blackFloat[off + x + 0] = 0.0
		// 		blackFloat[off + x + 1] = 0.0
		// 		blackFloat[off + x + 2] = 0.0
		// 		blackFloat[off + x + 3] = 0.0
		// 	}
		// 	off += this.width * 4
		// }
		// await this.black.hostAccess('writeonly')
		// Buffer.from(blackFloat.buffer).copy(this.black)

		const mixVidValve: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const xfDest = await this.clContext.createBuffer(
					numBytesRGBA,
					'readwrite',
					'coarse',
					{
						width: this.consumerFormat.width,
						height: this.consumerFormat.height
					},
					'transform'
				)
				xfDest.timestamp = frame.timestamp

				await this.transform?.run(
					{
						input: frame,
						flipH: false,
						flipV: false,
						anchorX: this.anchorParams.x - 0.5,
						anchorY: this.anchorParams.y - 0.5,
						scaleX: srcXscale * this.fillParams.xScale,
						scaleY: srcYscale * this.fillParams.yScale,
						rotate: -this.rotation / 360.0,
						offsetX: -this.fillParams.xOffset,
						offsetY: -this.fillParams.yOffset,
						output: xfDest
					},
					frame.timestamp,
					() => frame.release()
				)

				return xfDest
			} else {
				// this.black?.release()
				this.transform = null
				return frame
			}
		}

		// eslint-disable-next-line prettier/prettier
		this.mixAudio = srcAudio
			.valve(audMixFilter, { oneToMany: true })

		// eslint-disable-next-line prettier/prettier
		this.mixVideo = srcVideo
			.valve(mixVidValve)
	}

	setAnchor(x: number, y: number): boolean {
		this.anchorParams = { x: x, y: y }
		return true
	}

	setRotation(angle: number): boolean {
		this.rotation = angle
		return true
	}

	setFill(xPos: number, yPos: number, xScale: number, yScale: number): boolean {
		this.fillParams = { xOffset: xPos, yOffset: yPos, xScale: xScale, yScale: yScale }
		return true
	}

	setVolume(volume: number): boolean {
		this.volume = volume
		const volFilter = this.audMixFilterer?.graph.filters.find((f) => f.filter.name === 'volume')
		if (volFilter && volFilter.priv) volFilter.priv = { volume: this.volume.toString() }
		return true
	}

	getAudioPipe(): RedioPipe<Frame | RedioEnd> | undefined {
		return this.mixAudio
	}
	getVideoPipe(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined {
		return this.mixVideo
	}
}
