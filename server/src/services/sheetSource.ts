/**
 * One sheet at a time, out of a workbook that will not fit in memory.
 *
 * Everything in the import used to take `SheetGrid[]` — every tab of the file,
 * read and held together. That is fine for the three-tab spreadsheet it was
 * written against and it is what made a real workbook impossible: 39 tabs of
 * leads is a third of a million cells before anything has been decided about
 * them, the analyst is handed all 39 sheets in one prompt of ~100,000 tokens,
 * and the request runs long enough for whatever sits in front of the app to
 * give up on it. The Owner sees "The server didn't answer (502)".
 *
 * So the grids stop being a list and become something you ask for a sheet at a
 * time. A source holds **one** grid, the one last asked for; ask for the next
 * and the previous is dropped. Reading a single tab out of an `.xlsx` costs
 * roughly what reading all of them did before streaming, which is what makes
 * this affordable rather than merely correct — see `parseWorkbook`.
 *
 * The names come first and cost nothing, which is the other half of it: the
 * wizard can show 39 tabs and a progress bar before a single row is read.
 */

import { parseWorkbook, readWorkbookEach, type SheetGrid, type SheetVisitor } from "./spreadsheet.js";
import { getDriveFile, listTabs, readGrids, type DriveFile } from "../lib/google.js";

export interface GridSource {
  /** Every tab in the file, in the file's own order. */
  names(): Promise<string[]>;
  /** One tab, or undefined when the file has no such tab or it holds nothing. */
  get(name: string): Promise<SheetGrid | undefined>;
  /**
   * Several tabs in one pass, handed over one at a time and dropped after.
   *
   * `get` costs a whole pass of the file, because every worksheet in it has to
   * be read to the end whether or not it is wanted — see `streamEach`. Calling
   * it 39 times to build 39 previews is 39 passes; this is one, and holds no
   * more at a time than `get` does. The visitor is called in `names` order.
   */
  each(names: string[], visit: SheetVisitor): Promise<void>;
  /** What the file is called, for the record and for the error messages. */
  fileName(): Promise<string>;
  /** Let go of whatever is being held. */
  release(): void;
}

/** Holds the last sheet read and nothing else. */
abstract class OneSheetSource implements GridSource {
  private held: SheetGrid | null = null;
  private heldName: string | null = null;

  protected abstract read(name: string): Promise<SheetGrid | undefined>;
  abstract names(): Promise<string[]>;
  abstract fileName(): Promise<string>;
  abstract each(names: string[], visit: SheetVisitor): Promise<void>;

  async get(name: string): Promise<SheetGrid | undefined> {
    if (this.heldName === name) return this.held ?? undefined;
    // Dropped before the next read rather than after it, so the two are never
    // both in memory — which on a wide sheet is the difference that matters.
    this.held = null;
    this.heldName = null;
    const grid = await this.read(name);
    this.held = grid ?? null;
    this.heldName = name;
    return grid;
  }

  release() {
    this.held = null;
    this.heldName = null;
  }
}

class UploadSource extends OneSheetSource {
  constructor(
    private readonly buffer: Buffer,
    private readonly name: string,
  ) {
    super();
  }

  async names(): Promise<string[]> {
    const { listWorkbookSheets } = await import("./spreadsheet.js");
    return listWorkbookSheets(this.buffer, this.name);
  }

  async fileName(): Promise<string> {
    return this.name;
  }

  protected async read(name: string): Promise<SheetGrid | undefined> {
    // A CSV is one sheet whatever it is called, so asking for a tab by name
    // must not come back empty because the file was renamed on the way here.
    const grids = await parseWorkbook(this.buffer, this.name, [name]);
    return grids.find((grid) => grid.name === name) ?? (grids.length === 1 ? grids[0] : undefined);
  }

  async each(names: string[], visit: SheetVisitor): Promise<void> {
    if (!names.length) return;
    this.release();
    await readWorkbookEach(this.buffer, this.name, names, visit);
  }
}

class DriveSource extends OneSheetSource {
  private file: DriveFile | null = null;

  constructor(private readonly fileId: string) {
    super();
  }

  private async resolve(): Promise<DriveFile> {
    this.file ??= await getDriveFile(this.fileId);
    return this.file;
  }

  async names(): Promise<string[]> {
    return listTabs(await this.resolve());
  }

  async fileName(): Promise<string> {
    return (await this.resolve()).name;
  }

  protected async read(name: string): Promise<SheetGrid | undefined> {
    const { grids } = await readGrids(this.fileId, [name]);
    return grids.find((grid) => grid.name === name) ?? grids[0];
  }

  /** One API call per tab either way, so this is the loop and nothing is saved. */
  async each(names: string[], visit: SheetVisitor): Promise<void> {
    for (const name of names) {
      const grid = await this.get(name);
      if (grid) await visit(grid);
    }
    this.release();
  }
}

/** A source over grids already in hand — for the checks, and for a single-tab read. */
class HeldSource implements GridSource {
  constructor(private grids: SheetGrid[]) {}
  async names() {
    return this.grids.map((grid) => grid.name);
  }
  async get(name: string) {
    return this.grids.find((grid) => grid.name === name) ?? (this.grids.length === 1 ? this.grids[0] : undefined);
  }
  async each(names: string[], visit: SheetVisitor) {
    for (const name of names) {
      const grid = await this.get(name);
      if (grid) await visit(grid);
    }
  }
  async fileName() {
    return this.grids[0]?.name ?? "spreadsheet";
  }
  release() {
    this.grids = [];
  }
}

export const sourceFromUpload = (buffer: Buffer, fileName: string): GridSource => new UploadSource(buffer, fileName);
export const sourceFromDrive = (fileId: string): GridSource => new DriveSource(fileId);
export const sourceFromGrids = (grids: SheetGrid[]): GridSource => new HeldSource(grids);
