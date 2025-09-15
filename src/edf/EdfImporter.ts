/**
 * Epicurrents EDF importer.
 * @package    epicurrents/edf-reader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericBiosignalHeader, GenericStudyImporter } from '@epicurrents/core'
import { safeObjectFrom, secondsToTimeString } from '@epicurrents/core/dist/util'
import type {
    ConfigReadSignals,
    ConfigReadUrl,
    SignalStudyImporter,
    StudyContextFile,
    StudyFileContext,
} from '@epicurrents/core/dist/types'
import EdfDecoder from './EdfDecoder'
import EdfWorkerSubstitute from './EdfWorkerSubstitute'
import { headerToBiosignalHeader } from '#util'
import { ConfigReadEdfHeader, type EdfHeader, type EdfHeaderSignal } from '#types'
import Log from 'scoped-event-log'

const SCOPE = 'EdfImporter'

export default class EdfImporter extends GenericStudyImporter implements SignalStudyImporter {
    protected _decoder = new EdfDecoder()
    protected _useSAB: boolean

    constructor (useSAB = false) {
        const fileTypeAssocs = [
            {
                accept: {
                    "application/octet-stream": ['.edf', '.bdf'],
                },
                description: "European data format EDF/BDF",
            },
        ]
        super(SCOPE, [], fileTypeAssocs)
        this._useSAB = useSAB
        this._getWorkerSubstitute = () => new EdfWorkerSubstitute()
    }

    protected async _readSignalInfo (source: ArrayBuffer, config?: ConfigReadSignals) {
        this._decoder.appendInput(source)
        this._decoder.decodeHeader()
        const fullHeader = this._decoder.output
        // We should not have loaded large files with decoder, so cache the whole signal data.
        const totalRecords = fullHeader.dataUnitCount
        const signals = []
        for (let i=0; i<fullHeader.signalCount; i++) {
            const label = fullHeader.getSignalLabel(i) || ''
            const unitLow = fullHeader.getSignalPhysicalUnit(i)?.toLowerCase()
            const modality = config?.signals
                           ? config.signals[i]?.modality
                           // EDF Annotations are always a meta channel. Also treat channels without a unit as meta.
                           : label.toLowerCase() === 'edf annotations' || !unitLow?.trim()
                             ? 'meta'
                             : 'signal'
            // Try to determine amplification from unit.
            const scale = unitLow === 'uv' || unitLow === 'µv' ? 0
                        : unitLow === 'mv'
                            ? -3 : unitLow === 'v'
                                ?  -6 : 0
            // Try to determine record start.
            const sigData = {
                label,
                name: label,
                modality,
                samplingRate: fullHeader.getSignalSamplingFrequency(i) || 0,
                sensitivity: 0,
                signal: new Float32Array(),
                unit: fullHeader.getSignalPhysicalUnit(i) || '',
                samplesPerRecord: fullHeader.getSignalNumberOfSamplesPerRecord(i) || 0,
                sampleCount: 0,
                scale,
                physicalMin: fullHeader.getSignalPhysicalMin(i) || 0,
                physicalMax: fullHeader.getSignalPhysicalMax(i) || 0,
                filter: fullHeader.getSignalPrefiltering(i) || '',
                transducer: fullHeader.getSignalTransducerType(i) || '',
            } as EdfHeaderSignal
            sigData.sampleCount = sigData.samplesPerRecord*totalRecords
            // Check signal for validity.
            signals.push(sigData)
        }
        const meta = this._study.meta as {
            channels: EdfHeaderSignal[]
            header: GenericBiosignalHeader
            formatHeader: EdfHeader
        }
        meta.channels = signals
        meta.header = headerToBiosignalHeader(fullHeader.header)
        meta.formatHeader = fullHeader.header
        // Always overwrite study format and type with EDF/biosignal.
        this._study.format = 'edf'
        this._study.modality = 'signal'
    }

    getFileTypeWorker (override?: string): Worker | null {
        if (override === 'substitute') {
            return this._getWorkerSubstitute()
        }
        const getWorkerOverride = this._workerOverrides.get(override || 'edf')
        const worker = getWorkerOverride ? getWorkerOverride() : new Worker(
            /* webpackChunkName: 'edf.worker' */
            new URL('../workers/edf.worker', import.meta.url),
            { type: 'module' }
        )
        if (!getWorkerOverride) {
            Log.registerWorker(worker)
        }
        return worker
    }

    async readFile (source: File | StudyFileContext, config?: ConfigReadUrl) {
        const file = (source as StudyFileContext).file || source as File
        const fileType = file.name.endsWith('.bdf') ? 'bdf' : 'edf'
        const fileDesig = fileType.toUpperCase()
        Log.debug(`Loading ${fileType} from file ${file.webkitRelativePath}.`, SCOPE)
        const studyFile = {
            file: file,
            format: fileType,
            mime: config?.mime || file.type || null,
            name: config?.name || file.name || '',
            partial: false,
            range: [],
            role: 'data',
            modality: 'signal',
            url: config?.url || URL.createObjectURL(file),
        } as StudyContextFile
        try {
            // Load header part from the EDF file into the study.
            const mainHeader = file.slice(0, 256)
            const edfHeader = await this.readHeader(await mainHeader.arrayBuffer())
            if (!edfHeader) {
                Log.error(`Could not load ${fileDesig} header from the given file.`, SCOPE)
                return null
            }
            const fullHeader = file.slice(256, (edfHeader.signalCount + 1)*256)
            await this._readSignalInfo(await fullHeader.arrayBuffer(), config?.signalReader)
        } catch (e: unknown) {
            Log.error(`${fileDesig} header parsing error: ${(e as Error).message}.`, SCOPE, e as Error)
            return null
        }
        this._study.files.push(studyFile)
        return studyFile
    }

    async readHeader (source: ArrayBuffer, config?: ConfigReadEdfHeader): Promise<EdfHeader | null> {
        this._decoder.setInput(source)
        this._decoder.decodeHeader(true)
        const edfRecording = this._decoder.output
        const recType = edfRecording.isEdfPlus && edfRecording.isDiscontinuous
                        ? `EDF/BDF+ (discontinuous) file header parsed:`
                        : edfRecording.isEdfPlus
                        ? `EDF/BDF+ (continuous) file header parsed:`
                        : `EDF/BDF file header parsed:`
        Log.debug([
                recType,
                `${edfRecording.signalCount} signals,`,
                `${edfRecording.dataUnitCount} records,`,
                `${edfRecording.dataUnitDuration} seconds/record,`,
                `${secondsToTimeString(edfRecording.totalDuration)} duration.`,
            ], SCOPE
        )
        // Try to fetch metadata from header.
        // Saving metadata separately is important in case libraries are added or changed later.
        const meta = this._study.meta as EdfHeader & { header?: EdfHeader }
        if (!meta.header) {
            (this._study.meta as { header: EdfHeader }).header = safeObjectFrom(
                {
                    patientId: meta.patientId || edfRecording.patientId || '',
                    recordId: meta.recordId || edfRecording.recordingId || null,
                    startDate: meta.startDate || edfRecording.recordingStartTime || null,
                    nDataRecords: edfRecording.dataUnitCount || null,
                    recordLen: edfRecording.dataUnitDuration || null,
                    signalCount: edfRecording.signalCount || 0,
                }
            )
        } else {
            meta.header.patientId = meta.patientId || edfRecording.patientId || ''
            meta.header.recordId = meta.recordId || edfRecording.recordingId || null
            meta.header.startDate = meta.startDate || edfRecording.recordingStartTime || null
            meta.header.nDataRecords = edfRecording.dataUnitCount || null
            meta.header.recordLen = edfRecording.dataUnitDuration || null
            meta.header.signalCount = edfRecording.signalCount || 0
        }
        if (config?.signals?.length) {
            await this._readSignalInfo(source, config as ConfigReadSignals)
        }
        return meta.header || null
    }

    async readUrl (source: string | StudyFileContext, config?: ConfigReadUrl) {
        const url = (source as StudyFileContext).url || source as string
        const fileType = config?.name?.endsWith('.bdf') || url.endsWith('.bdf') ? 'bdf' : 'edf'
        const fileDesig = fileType.toUpperCase()
        Log.debug(`Loading ${fileDesig} from url ${url}.`, SCOPE)
        const studyFile = {
            file: null,
            format: fileType,
            mime: config?.mime || null,
            name: config?.name || '',
            partial: false,
            range: [],
            role: 'data',
            modality: 'signal',
            url: config?.url || url,
        } as StudyContextFile
        try {
            // Load header part from the EDF file into the study.
            const headers = new Headers()
            headers.set('range', 'bytes=0-255')
            if (config?.authHeader) {
                headers.set('Authorization', config.authHeader)
            }
            const mainHeader = await fetch(url, {
                headers: headers,
            })
            const edfHeader = await this.readHeader(await mainHeader.arrayBuffer())
            if (!edfHeader) {
                Log.error(`Could not load ${fileDesig} header from the given URL.`, SCOPE)
                return null
            }
            // Load full header including signal info.
            headers.set('range', `bytes=256-${(edfHeader.signalCount + 1)*256 - 1}`)
            if (config?.authHeader) {
                headers.set('Authorization', config.authHeader)
            }
            const fullHeader = await fetch(url, {
                headers: headers,
            })
            await this._readSignalInfo(await fullHeader.arrayBuffer(), config?.signalReader)
        } catch (e: unknown) {
            Log.error(`${fileDesig} header parsing error: ${(e as Error).message}.`, SCOPE, e as Error)
            return null
        }
        this._study.files.push(studyFile)
        return studyFile
    }
}
