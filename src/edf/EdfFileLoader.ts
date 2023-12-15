/**
 * EpiCurrents EDF file loader.
 * @package    @epicurrents/edf-file-loader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericBiosignalHeaders, GenericFileLoader } from '@epicurrents/core'
import { safeObjectFrom, secondsToTimeString } from '@epicurrents/core/dist/util'
import {
    type ConfigLoadHeader,
    type ConfigLoadSignals,
    type ConfigLoadUrl,
    type SignalFileLoader,
    type StudyContextFile,
    type StudyFileContext,
} from '@epicurrents/core/dist/types'
import EdfDecoder from './EdfDecoder'
import { type EdfHeader, type EdfHeaderSignal } from '../types/edf'
import Log from 'scoped-ts-log'

const SCOPE = 'EdfFileLoader'

export default class EdfFileLoader extends GenericFileLoader implements SignalFileLoader {
    protected _decoder = new EdfDecoder()

    constructor () {
        super(SCOPE, [], ['.edf'])
    }

    get fileType () {
        return 'edf'
    }

    getFileTypeWorker (): Worker | null {
        if (this._app.useMemoryManager) {
            return new Worker(new URL('./EdfWorkerSAB.js', import.meta.url))
        } else {
            return new Worker(new URL('./EdfWorker.js', import.meta.url))
        }
    }

    async loadFile (source: File | StudyFileContext, config = {} as any) {
        const file = (source as StudyFileContext).file || source as File
        Log.debug(`Loading EDF from file ${file.webkitRelativePath}.`, SCOPE)
        const studyFile = {
            file: file,
            format: 'edf',
            mime: config?.mime || file.type || null,
            name: config?.name || file.name || '',
            partial: false,
            range: [],
            role: 'data',
            type: EdfFileLoader.SCOPES.BIOSIGNAL,
            url: config?.url || URL.createObjectURL(file),
        } as StudyContextFile
        try {
            // Load header part from the EDF file into the study.
            const mainHeader = file.slice(0, 255)
            const edfHeader = await this.loadHeader(await mainHeader.arrayBuffer(), config)
            if (!edfHeader) {
                Log.error("Could not load EDF headers from given file.", SCOPE)
                return null
            }
            const fullHeader = file.slice(256, (edfHeader.signalCount + 1)*256 - 1)
            await this.loadSignals(await fullHeader.arrayBuffer(), config)
        } catch (e: any) {
            Log.error("EDF header parsing error:", SCOPE, e)
            return null
        }
        this._study.files.push(studyFile)
        return studyFile
    }

    loadHeader (source: ArrayBuffer, config?: ConfigLoadHeader) {
        this._decoder.setInput(source)
        this._decoder.decodeHeader(true)
        const edfRecording = this._decoder.output
        const recType = edfRecording.isEdfPlus && edfRecording.isDiscontinuous
                        ? `EDF+ (discontinuous) file header parsed:`
                        : edfRecording.isEdfPlus
                        ? `EDF+ (continuous) file header parsed:`
                        : `EDF file header parsed:`
        Log.debug([
                recType,
                `${edfRecording.signalCount} signals,`,
                `${edfRecording.dataRecordCount} records,`,
                `${edfRecording.dataRecordDuration} seconds/record,`,
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
                    nDataRecords: edfRecording.dataRecordCount || null,
                    recordLen: edfRecording.dataRecordDuration || null,
                    signalCount: edfRecording.signalCount || 0,
                }
            )
        } else {
            meta.header.patientId = meta.patientId || edfRecording.patientId || ''
            meta.header.recordId = meta.recordId || edfRecording.recordingId || null
            meta.header.startDate = meta.startDate || edfRecording.recordingStartTime || null
            meta.header.nDataRecords = edfRecording.dataRecordCount || null
            meta.header.recordLen = edfRecording.dataRecordDuration || null
            meta.header.signalCount = edfRecording.signalCount || 0
        }
        return meta.header
    }

    async loadSignals (source: ArrayBuffer, config?: ConfigLoadSignals) {
        this._decoder.appendInput(source)
        this._decoder.decodeHeader()
        const fullHeader = this._decoder.output
        // We should not have loaded large files with decoder, so cache the whole signal data.
        const totalRecords = fullHeader.dataRecordCount
        const signals = []
        for (let i=0; i<fullHeader.signalCount; i++) {
            const sigType = config?.signals ? config.signals[i]?.type : 'sig'
            // Try to determine amplification from unit.
            const unitLow = fullHeader.getSignalPhysicalUnit(i)?.toLowerCase()
            const amplification = unitLow === 'uv' || unitLow === 'µv' ? 1
                                    : unitLow === 'mv' ? 1_000 : unitLow === 'v' ?  1_000_000 : 1
            const label = fullHeader.getSignalLabel(i) || ''
            // Try to determine record start.
            const sigData = {
                label: label,
                name: label,
                type: sigType,
                samplingRate: fullHeader.getSignalSamplingFrequency(i) || 0,
                amplification: amplification,
                sensitivity: 0,
                signal: new Float32Array(),
                unit: fullHeader.getSignalPhysicalUnit(i) || '',
                samplesPerRecord: fullHeader.getSignalNumberOfSamplesPerRecord(i) || 0,
                sampleCount: 0,
                physicalMin: fullHeader.getSignalPhysicalMin(i) || 0,
                physicalMax: fullHeader.getSignalPhysicalMax(i) || 0,
                filter: fullHeader.getSignalPrefiltering(i) || '',
                transducer: fullHeader.getSignalTransducerType(i) || '',
            } as EdfHeaderSignal
            sigData.sampleCount = sigData.samplesPerRecord * totalRecords
            // Check signal for validity.
            signals.push(sigData)
        }
        const meta = this._study.meta as {
            channels: EdfHeaderSignal[]
            header:  GenericBiosignalHeaders
            formatHeader: EdfHeader
        }
        meta.channels = signals
        meta.header = EdfDecoder.HeaderToBiosignalHeader(fullHeader.header)
        meta.formatHeader = fullHeader.header
        // Always overwrite study format and type with EDF/biosignal.
        this._study.format = 'edf'
        this._study.scope = EdfFileLoader.SCOPES.BIOSIGNAL
    }

    async loadUrl (source: string | StudyFileContext, config?: ConfigLoadUrl) {
        const url = (source as StudyFileContext).url || source as string
        Log.debug(`Loading EDF from url ${url}.`, SCOPE)
        const studyFile = {
            file: null,
            format: 'edf',
            mime: config?.mime || null,
            name: config?.name || '',
            partial: false,
            range: [],
            role: 'data',
            type: EdfFileLoader.SCOPES.BIOSIGNAL,
            url: config?.url || url,
        } as StudyContextFile
        try {
            // Load header part from the EDF file into the study.
            const headers = new Headers()
            headers.set('range', 'bytes=0-255')
            const mainHeader = await fetch(url, {
                headers: headers,
            })
            const edfHeader = await this.loadHeader(await mainHeader.arrayBuffer(), config?.headerLoader)
            if (!edfHeader) {
                Log.error("Could not load EDF headers from given URL.", SCOPE)
                return null
            }
            // Load full header including signal info.
            headers.set('range', `bytes=256-${(edfHeader.signalCount + 1)*256 - 1}`)
            const fullHeader = await fetch(url, {
                headers: headers,
            })
            await this.loadSignals(await fullHeader.arrayBuffer(), config?.signalLoader)
        } catch (e: any) {
            Log.error("EDF header parsing error!", SCOPE, e)
            return null
        }
        this._study.files.push(studyFile)
        return studyFile
    }
}
