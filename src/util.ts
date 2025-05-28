/**
 * Epicurrents EDF utilities.
 * @package    epicurrents/edf-reader
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

import type { EdfHeader, EdfSignalInfo } from '#types'
import { GenericBiosignalHeader } from '@epicurrents/core'
import { BiosignalFilters } from '@epicurrents/core/dist/types'

/**
 * Try to extract the modality of signal from the signal info.
 * @param signal - Signal information from the EDF header.
 * @param labelMatchers - A map of labels (RegExp strings) to signal modalities (optional).
 * @returns Modality of the signal or empty string if unsuccessful.
 */
export const extractSignalModality = (signal: EdfSignalInfo, labelMatchers?: Map<string, string>): string => {
    const label = signal.label
    const matchers = labelMatchers
                        ? labelMatchers
                        : new Map<string, string>()
    // Apply a set of default label matchers after the custom matchers.
    const defaultMatchers = [
        // Often all signal labels in an EEG EDF export have "EEG" prefixed or mentioned,
        // so try to match to polygraphic signals first.
        ["emg", "emg"],
        ["eog", "eog"],
        ["ecg|ekg", "ekg"],
        ["eeg", "eeg"],
    ]
    for (const [defLabel, defType] of defaultMatchers) {
        if (!matchers.has(defLabel)) {
            matchers.set(defLabel, defType)
        }
    }
    for (const [matchLabel, matchType] of matchers) {
        if (label.match(new RegExp(matchLabel))) {
            return matchType
        }
    }
    return ""
}
/**
 * Convert the given EDF header record into generic biosignal headers.
 * @param headers - Parsed EDF headers.
 * @returns Biosignal header record.
 */
export const headerToBiosignalHeader = (headers: EdfHeader) => {
    const biosigHeaders = new GenericBiosignalHeader(
        headers.dataFormat,
        headers.patientId,
        headers.patientId,
        headers.dataRecordCount,
        headers.dataRecordDuration,
        headers.recordByteSize,
        headers.signalCount,
        headers.signalInfo.map(s => {
            return {
                label: s.label,
                modality: extractSignalModality(s),
                name: s.label,
                physicalUnit: s.physicalUnit,
                prefiltering: parsePrefiltering(s.prefiltering),
                sampleCount: s.sampleCount,
                samplingRate: s.sampleCount/headers.dataRecordDuration,
                sensitivity: 0,
                sensor: s.transducerType,
            }
        }),
        headers.recordingDate,
        headers.discontinuous,
        [],
    )
    return biosigHeaders
}
/**
 * Check if the given signal is an annotation signal.
 * @param format - Recording format or the reserved field from EDF header.
 * @param channel - Channel info from EDF header.
 * @returns true/false
 */
export const isAnnotationSignal = (format: string, channel: { label: string }) => {
    return format.toLowerCase().startsWith('edf+') && channel.label === 'EDF Annotations'
}
/**
 * Parse EDF signal prefiltering field per the suggestion in the official EDF spec.
 * @param prefiltering - Prefiltering information as a string.
 * @returns Biosignal filters.
 */
export const parsePrefiltering = (prefiltering: string): BiosignalFilters => {
    const filterHp = prefiltering.match(/HP:([0-9\\.]+)Hz/i)
    const filterLp = prefiltering.match(/LP:([0-9\\.]+)Hz/i)
    const filterNotch = prefiltering.match(/N:([0-9\\.]+)Hz/i)
    return {
        bandreject: [],
        highpass: filterHp ? parseFloat(filterHp[1]) : 0,
        lowpass: filterLp ? parseFloat(filterLp[1]) : 0,
        notch: filterNotch ? parseFloat(filterNotch[1]) : 0,
    }
}
/**
 * Convert a string to a UTF-8 byte array.
 * @param input - The string to convert to a UTF-8 byte array.
 * @returns An array of bytes representing the UTF-8 encoded string.
 * @privateRemarks
 * Not really needed since TextEncoder is available in most browsers, but I'll leave this here in case a polyfill is
 * needed at some point.
 * Inspired by from https://gist.github.com/joni/3760795.
 */
export const textToUTF8Array = (input: string) => {
    const output = [] as number[]
    for (let i=0; i<input.length; i++) {
        let charcode = input.charCodeAt(i)
        if (charcode < 0x80) {
            // 0x00-0x7F is a single byte in UTF-8, we can add it directly.
            output.push(charcode)
        }  else if (charcode < 0x800) {
            // 0x80-0x7FF is a two-byte sequence in UTF-8.
            // The first byte is 0xc0 + (charcode >> 6) and the second byte is 0x80 + (charcode & 0x3f).
            // This means the first byte has the two most significant bits set to 1 and the next six bits are the first
            // six bits of the character code, and the second byte has the two most significant bits set to 0 and the
            // next six bits are the last six bits of the character code.
            output.push(
                0xc0 | (charcode >> 6),
                0x80 | (charcode & 0x3f)
            )
        } else if (charcode < 0xd800 || charcode >= 0xe000) {
            // 0x800-0xFFFF is a three-byte sequence in UTF-8.
            // The first byte is 0xe0 + (charcode >> 12), the second byte is 0x80 + ((charcode >> 6) & 0x3f), and the
            // third byte is 0x80 + (charcode & 0x3f).
            // This means the first byte has the three most significant bits set to 1 and the next four bits are the
            // first four bits of the character code, the second byte has the two most significant bits set to 1 and
            // the next six bits are the next six bits of the character code, and the third byte has the two most
            // significant bits set to 0 and the next six bits are the last six bits of the character code.
            // We skip surrogate pairs (0xd800-0xdfff) here, as they are not valid UTF-8 characters.
            output.push(
                0xe0 | (charcode >> 12),
                0x80 | ((charcode >> 6) & 0x3f),
                0x80 | (charcode & 0x3f)
            )
        } else {
            // Surrogate pairs handling.
            // JavaScript's internal UTF-16 encodes 0x10000-0x10FFFF by subtracting 0x10000 and splits the 20 bits
            // from 0x0-0xFFFFF into two parts.
            // The first byte is 0xf0 + (charcode >> 18), the second byte is 0x80 + ((charcode >> 12) & 0x3f),
            // the third byte is 0x80 + ((charcode >> 6) & 0x3f), and the fourth byte is 0x80 + (charcode & 0x3f).
            // We need to increment the index to skip the next character, as we are processing a surrogate pair.
            // Note: The input string is expected to be a valid UTF-16 string, so we assume that the next character
            // is always a valid surrogate pair character.
            i++
            charcode = 0x10000 + (
                ((charcode & 0x3ff) << 10)
                | (input.charCodeAt(i) & 0x3ff)
            )
            output.push(
                0xf0 | (charcode >> 18),
                0x80 | ((charcode >> 12) & 0x3f),
                0x80 | ((charcode >> 6) & 0x3f),
                0x80 | (charcode & 0x3f)
            )
        }
    }
    return output
}
