import { buildURLString } from '../actions/url-utils';
import { fetchJson, fetchJsonPromise, fetchPost, logException } from '../fetcher';
import * as GenericRepository from '../repository/GenericRepository';

import { ColumnDef, ColumnFormat, DataViewerState, InstanceSettings, RangeHighlight } from './DataViewerState';

/** Type-defintion for any callback function */
type Callback = (response?: Record<string, any>) => void;

/** Object returned from post requests */
interface PostResponse {
  success: boolean;
  error?: string;
  traceback?: string;
}

export const buildCallback =
  (route: string, dataId: string, params: Record<string, string>): (() => void) =>
  () =>
    fetchJson(buildURLString(`/dtale/${route}/${dataId}?`, params));

/** Parameters required for any column operation (locking or moving) */
interface ColumnOperationProps {
  columns: ColumnDef[];
  propagateState: (state: Partial<DataViewerState>, callback?: () => void) => void;
  dataId: string;
}

/** Different column movements */
type MoveAction = 'front' | 'back' | 'left' | 'right';

/**
 * Create a function to move a column one position left or right.
 *
 * @param selectedCol the column to move
 * @param props input parameters for column operations
 * @param action the movement to make
 * @return function to move a column
 */
function moveOnePosition(selectedCol: string, props: ColumnOperationProps, action: MoveAction): () => void {
  const { columns, propagateState, dataId } = props;
  return () => {
    const locked = columns.filter((column) => column.locked);
    const unlocked = columns.filter((column) => !column.locked);
    const selectedIdx = unlocked.findIndex(({ name }) => name === selectedCol);
    if (action === 'right' && selectedIdx === unlocked.length - 1) {
      return;
    }
    if (action === 'left' && selectedIdx === 0) {
      return;
    }
    const moveToRightIdx = action === 'right' ? selectedIdx : selectedIdx - 1;
    const moveToRight = { ...unlocked[moveToRightIdx] };
    const moveToLeftIdx = action === 'right' ? selectedIdx + 1 : selectedIdx;
    const moveToLeft = { ...unlocked[moveToLeftIdx] };
    unlocked[moveToRightIdx] = moveToLeft;
    unlocked[moveToLeftIdx] = moveToRight;
    const finalCols = [...locked, ...unlocked];
    const callback = buildCallback('update-column-position', dataId, {
      col: selectedCol,
      action,
    });
    propagateState({ columns: finalCols, triggerResize: true }, callback);
  };
}

/**
 * Create a function to move a column to the front or back.
 *
 * @param selectedCol the column to move
 * @param props input parameters for column operations
 * @param action the movement to make
 * @return a function to move a column
 */
function moveTo(selectedCol: string, props: ColumnOperationProps, action: MoveAction = 'front'): () => void {
  const { columns, propagateState, dataId } = props;
  return () => {
    const locked = columns.filter((column) => column.locked);
    const colsToMove = columns.filter((column) => selectedCol === column.name && !column.locked);
    const unselectedAndUnlockedCols = columns.filter(
      ({ name }) => selectedCol !== name && !locked.find((column) => column.name === name),
    );
    const finalCols =
      action === 'front'
        ? [...locked, ...colsToMove, ...unselectedAndUnlockedCols]
        : [...locked, ...unselectedAndUnlockedCols, ...colsToMove];
    const callback = buildCallback('update-column-position', dataId, {
      col: selectedCol,
      action,
    });
    propagateState({ columns: finalCols, triggerResize: true }, callback);
  };
}

/**
 * Create a function to pin columns to the left-hand side of the grid.
 *
 * @param selectedCols the columns to pin
 * @param props input parameters for column operations
 * @return a function to pin columns
 */
export function lockCols(selectedCols: string[], props: ColumnOperationProps): () => void {
  const { columns, propagateState, dataId } = props;
  return () => {
    const currentlyLocked = columns.filter((column) => column.locked);
    const newLocks = columns
      .filter(({ name }) => selectedCols.includes(name))
      .map((column) => ({ ...column, locked: true }));
    const locked = [...currentlyLocked, ...newLocks];
    const callback = buildCallback('update-locked', dataId, {
      col: selectedCols[0],
      action: 'lock',
    });
    propagateState(
      {
        columns: [...locked, ...columns.filter(({ name }) => !locked.find((column) => column.name === name))],
        fixedColumnCount: locked.length,
        selectedCols: [],
        triggerResize: true,
      },
      callback,
    );
  };
}

/**
 * Create a function to unpin columns from the left-hand side of the grid.
 *
 * @param selectedCols the columns to unpin
 * @param props input parameters for column operations
 * @return a function unpin columns
 */
export function unlockCols(selectedCols: string[], props: ColumnOperationProps): () => void {
  const { columns, propagateState, dataId } = props;
  return () => {
    const currentlyLocked = columns.filter((column) => column.locked);
    const unlocked = currentlyLocked
      .filter(({ name }) => selectedCols.includes(name))
      .map((column) => ({ ...column, locked: false }));
    const locked = currentlyLocked.filter(({ name }) => !selectedCols.includes(name));
    const callback = buildCallback('update-locked', dataId, {
      col: selectedCols[0],
      action: 'unlock',
    });
    propagateState(
      {
        columns: [...locked, ...unlocked, ...columns.filter((c) => !c.locked)],
        fixedColumnCount: locked.length,
        selectedCols: [],
        triggerResize: true,
      },
      callback,
    );
  };
}

/**
 * Persist the visibility of columns to the server.
 *
 * @param dataId identifier of the current data instance.
 * @param params url parameters
 * @return post response
 */
async function persistVisibility(dataId: string, params: Record<string, string>): Promise<PostResponse | undefined> {
  try {
    return await GenericRepository.postDataToService<Record<string, string>, PostResponse>(
      `/dtale/update-visibility/${dataId}`,
      params,
    );
  } catch (e) {
    logException(e as Error, (e as Error).stack);
  }
  return undefined;
}

/**
 * Persist instance-based settings to the server.
 *
 * @param settings the instance settings to save.
 * @param dataId identifier of the current data instance.
 * @param callback action to be taken after settings has been persisted.
 */
export function updateSettings(settings: Partial<InstanceSettings>, dataId: string, callback?: Callback): void {
  fetchJsonPromise(
    buildURLString(`/dtale/update-settings/${dataId}?`, {
      settings: JSON.stringify(settings),
    }),
  )
    .then(callback)
    .catch((e: any) => {
      logException(e as Error);
    });
}

/**
 * Drop currently filtered rows from your data server-side.
 *
 * @param dataId identifier of the current data instance.
 * @param callback action to be taken after rows have been dropped.
 */
export function dropFilteredRows(dataId: string, callback?: Callback): void {
  fetchJsonPromise(`/dtale/drop-filtered-rows/${dataId}`)
    .then(callback)
    .catch((e: any) => {
      logException(e as Error);
    });
}

export const moveFiltersToCustom = (dataId: string, callback: Callback): void =>
  fetchJson(`/dtale/move-filters-to-custom/${dataId}`, callback);

export const renameColumn = (dataId: string, col: string, rename: string, callback: Callback): void =>
  fetchJson(buildURLString(`/dtale/rename-col/${dataId}`, { col, rename }), callback);

/**
 * Persist a column format to the server.
 *
 * @param dataId identifier of the current data instance.
 * @param col the column whose format to save
 * @param format the format configuration
 * @param all whether to apply the format to all columns of a similar data type or not.
 * @param nanDisplay the string to use to represent any NaN data.
 * @param callback action to be taken after format has been saved.
 */
export function updateFormats(
  dataId: string,
  col: string,
  format: ColumnFormat,
  all: boolean,
  nanDisplay: string,
  callback?: Callback,
): void {
  fetchJson(
    buildURLString(`/dtale/update-formats/${dataId}`, {
      col,
      format: JSON.stringify(format),
      all: `${all}`,
      nanDisplay,
    }),
    callback,
  );
}

/**
 * Persist range highlighting configuration to the server.
 *
 * @param dataId identifier of the current data instance.
 * @param ranges range configurations to persist.
 * @param callback action to be taken after format has been saved.
 */
export function saveRangeHighlights(dataId: string, ranges: RangeHighlight, callback: Callback): void {
  try {
    fetchPost(`/dtale/save-range-highlights/${dataId}`, { ranges: JSON.stringify(ranges) }, callback);
  } catch (e) {
    logException(e as Error, (e as Error).stack);
  }
}

/**
 * Edit a value at a specific row/column server-side.
 *
 * @param dataId identifier of the current data instance.
 * @param col the column of the value to update.
 * @param rowIndex the row of the value to update.
 * @param updated the value to update to.
 * @param callback action to be taken after value has been updated.
 */
export function editCell(dataId: string, col: string, rowIndex: number, updated: string, callback: Callback): void {
  fetchJson(
    buildURLString(`/dtale/edit-cell/${dataId}`, {
      col,
      rowIndex: `${rowIndex}`,
      updated,
    }),
    callback,
  );
}

export const updateTheme = (theme: string, callback: Callback): void =>
  fetchJson(buildURLString('/dtale/update-theme', { theme }), callback);

export const updateQueryEngine = (engine: string, callback: Callback): void =>
  fetchJson(buildURLString('/dtale/update-query-engine', { engine }), callback);

export const updatePinMenu = (pinned: boolean, callback: Callback): void =>
  fetchJson(buildURLString('/dtale/update-pin-menu', { pinned: `${pinned}` }), callback);

export const updateLanguage = (language: string, callback: Callback): void =>
  fetchJson(buildURLString('/dtale/update-language', { language }), callback);

export const updateMaxColumnWidth = (width: number, callback: Callback): void =>
  fetchJson(buildURLString('/dtale/update-maximum-column-width', { width: `${width}` }), callback);

export const updateMaxRowHeight = (height: number, callback: Callback): void =>
  fetchJson(buildURLString('/dtale/update-maximum-row-height', { height: `${height}` }), callback);

export const loadFilteredRanges = (dataId: string, callback: Callback): void => {
  fetchJsonPromise(`/dtale/load-filtered-ranges/${dataId}`)
    .then(callback)
    .catch((e: any) => {
      logException(e as Error);
    });
};

/**
 * Helper function for deleting columns server-side.
 *
 * @param dataId identifier of the current data instance.
 * @param cols the columns to remove from your dataset.
 */
function deleteCols(dataId: string, cols: string[]): void {
  fetchJson(
    buildURLString(`/dtale/delete-col/${dataId}`, {
      cols: JSON.stringify(cols),
    }),
  );
}

export const moveToFront = (selectedCol: string, props: ColumnOperationProps): (() => void) =>
  moveTo(selectedCol, props, 'front');
export const moveToBack = (selectedCol: string, props: ColumnOperationProps): (() => void) =>
  moveTo(selectedCol, props, 'back');
export const moveRight = (selectedCol: string, props: ColumnOperationProps): (() => void) =>
  moveOnePosition(selectedCol, props, 'right');
export const moveLeft = (selectedCol: string, props: ColumnOperationProps): (() => void) =>
  moveOnePosition(selectedCol, props, 'left');
export const updateVisibility = async (dataId: string, visibility: boolean): Promise<PostResponse | undefined> =>
  await persistVisibility(dataId, { visibility: JSON.stringify(visibility) });
export const toggleVisibility = async (dataId: string, toggle: string): Promise<PostResponse | undefined> =>
  await persistVisibility(dataId, { toggle });
export const deleteColumn =
  (dataId: string, col: string): (() => void) =>
  () =>
    deleteCols(dataId, [col]);
export const deleteColumns =
  (dataId: string, cols: string[]): (() => void) =>
  () =>
    deleteCols(dataId, cols);
