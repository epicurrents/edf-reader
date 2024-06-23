/**
 * Epicurrents EDF utilities.
 * @package    epicurrents/edf-reader
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

/**
 * Check if the given signal is an annotation signal.
 * @param format - Recording format or the reserved field from EDF header.
 * @param channel - Channel info from EDF header.
 * @returns true/false
 */
export const isAnnotationSignal = (format: string, channel: { label: string }) => {
    return format.toLowerCase().startsWith('edf+') && channel.label === 'EDF Annotations'
}