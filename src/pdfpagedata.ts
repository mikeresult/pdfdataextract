import { PDFPageProxy, TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import { OCRLang, Sort } from './types';
import { PageViewport } from 'pdfjs-dist/types/src/display/display_utils';
import { CanvasApi, CanvasApiConstructor } from './canvasapi';
import { OcrApi, OcrApiConstructor } from './ocrapi';

/**
 * pdf data information per page
 */
export class PdfPageData {
	/**
	 * @internal
	 */
	public constructor(
		private page: PDFPageProxy,
		private readonly canvasApi: CanvasApiConstructor<CanvasApi> | null,
		private readonly ocrApi: OcrApiConstructor<OcrApi> | null,
	) { }

	/**
	 * get the text of the page
	 * 
	 * @param {boolean|Sort} [sort=false] - sort the text by text coordinates
	 * @param {number} [columns] - the number of columns to be used to extract the text, by default it is not used
	 * @param {string} [columnDivider] - the string to be used to indicate column breaks, by default it is not used
	 * @param {number} [fuzzy] - the amount of fuzziness to use for text extraction, by default exact alignment is used
	 * @returns {Promise<string>} a promise that is resolved with a {string} with the extracted text of the page
	 */
	public async toText(sort: boolean | Sort = false, columns?: number, columnDivider?: string, fuzzy?: number): Promise<string> {
		const sortOption: Sort | null = typeof sort === 'boolean' ? (sort ? Sort.ASC : null) : sort;
		return this.page.getTextContent({
			disableNormalization: false,
			includeMarkedContent: false,
		}).then((textContent: TextContent) => {
			const items: TextItem[] = textContent.items as TextItem[];
			/*
				transform is a array with a transform matrix [scale x,shear x,shear y,scale y,offset x,offset y]
			
				0,1         1,1
				  -----------
				  |         |
				  |         |
				  |   pdf   |
				  |         |
				  |         |
				  -----------
				0,0         1,0
			*/

			//coordinate based sorting
			if (sortOption !== null) {
				const columnBreaks: number[] = [];
				if (columns && columns > 1) {
					// compute the positions of the column breaks
					const maxX: number = Math.max(...items.map((i: TextItem) => i.transform[4]));
					for (let c: number = 1; c < columns; c++) {
						columnBreaks.push(c * maxX / columns);
						// inject the column dividers, if defined
						if (columnDivider !== undefined) {
							items.push({
								str: columnDivider,
								transform: [0, 0, 0, 1, c * maxX / columns - 1, 0],
							} as TextItem);
						}
					}
				}
				if (sortOption === Sort.ASC) {
					items.sort((e1: TextItem, e2: TextItem) => {
						// sort by column
						const column1: number = columnBreaks.findIndex((b: number) => b > e1.transform[4]);
						const column2: number = columnBreaks.findIndex((b: number) => b > e2.transform[4]);
						if (column1 !== column2) return column2 - column1;
						// sort by y position
						const yDiff: number = Math.abs(e1.transform[5] - e2.transform[5]);
						const isFuzzy: boolean = fuzzy !== undefined && fuzzy > 0 && yDiff <= fuzzy;
						if (!isFuzzy && e1.transform[5] < e2.transform[5]) return 1;
						if (!isFuzzy && e1.transform[5] > e2.transform[5]) return -1;
						// sort by x position
						if (e1.transform[4] < e2.transform[4]) return -1;
						if (e1.transform[4] > e2.transform[4]) return 1;
						return 0;
					});
				} else {
					items.sort((e1: TextItem, e2: TextItem) => {
						// sort by column
						const column1: number = columnBreaks.findIndex((b: number) => b > e1.transform[4]);
						const column2: number = columnBreaks.findIndex((b: number) => b > e2.transform[4]);
						if (column1 !== column2) return column1 - column2;
						// sort by y position
						const yDiff: number = Math.abs(e1.transform[5] - e2.transform[5]);
						const isFuzzy: boolean = fuzzy !== undefined && fuzzy > 0 && yDiff <= fuzzy;
						if (!isFuzzy && e1.transform[5] < e2.transform[5]) return -1;
						if (!isFuzzy && e1.transform[5] > e2.transform[5]) return 1;
						// sort by x position
						if (e1.transform[4] < e2.transform[4]) return 1;
						if (e1.transform[4] > e2.transform[4]) return -1;
						return 0;
					});
				}
			}

			let lastLineY: number = -1, text: string = '';
			for (const item of items) {
				const yDiff: number = Math.abs(lastLineY - item.transform[5]);
				const isFuzzy: boolean = fuzzy !== undefined && fuzzy > 0 && yDiff <= fuzzy;
				// same line if y coordinate is the same as the last item or within the fuzzy range
				if (lastLineY === -1 || lastLineY == item.transform[5] || isFuzzy) {
					if (isFuzzy && lastLineY !== item.transform[5]) {
						// elements which are nearly lined up often lack a space between them
						text += ' ' + item.str + ' ';
					} else {
						text += item.str;
					}
				} else {
					text += '\n' + item.str;
				}
				lastLineY = item.transform[5];
			}
			return text;
		}, () => '');
	}

	/**
	 * recognizes the text from the image information of this pdf page
	 * requires node-canvas/node-pureimage and tesseract.js as additional installation
	 * 
	 * @param {OCRLang[]} langs - the language traineddata used for recognition
	 * @returns {Promise<string>} the result as text
	 */
	public async ocr(langs: OCRLang[]): Promise<string> {
		if (!this.ocrApi) throw new Error('OcrFactory.ocrApi is not set (tesseractjs)');
		const ocr: OcrApi = new this.ocrApi();
		const result: string[] = await ocr.ocrBuffers([await this.toJPEG()], langs);
		return result[0];
	}

	/**
	 * creates a canvas and renders 
	 *
	 * @param {T} canvasApi - the canvas api that is used to create the canvas
	 * @returns {Promise<T>} the canvas
	 */
	public async toCanvasApi<T extends CanvasApi>(canvasApi: CanvasApiConstructor<T>): Promise<T> {
		const viewport: PageViewport = this.page.getViewport({ scale: 1.0 });
		const canvas: T = new canvasApi(viewport.width, viewport.height);
		await this.page.render({
			canvasContext: canvas.createContext(),
			viewport: viewport,
		}).promise;
		return canvas;
	}

	/**
	 * converts to a jpeg image
	 *
	 * @param {number} [quality=0.8] - the quality of the image (0.0-1.0)
	 * @returns {Promise<Buffer>} the jpeg image as a {Buffer}
	 */
	public async toJPEG(quality: number = 0.8): Promise<Buffer> {
		if (!this.canvasApi) throw new Error('canvasApi is not set (node-canvas or pureimage is not installed)');
		return (await this.toCanvasApi(this.canvasApi)).toJPEG(quality);
	}

	/**
	 * converts to a png image
	 *
	 * @returns {Promise<Buffer>} the png image as a {Buffer}
	 */
	public async toPNG(): Promise<Buffer> {
		if (!this.canvasApi) throw new Error('canvasApi is not set (node-canvas or pureimage is not installed)');
		return (await this.toCanvasApi(this.canvasApi)).toPNG();
	}

	/**
	 * close the page data
	 * @returns {boolean} — if close was successfully
	 */
	public close(): boolean {
		return this.page.cleanup();
	}
}