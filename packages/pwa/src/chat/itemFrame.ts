/**
 * Class of the wrapper around every chat item (top level and nested). The wrapper carries `data-item-id` and the
 * `data-highlighted` flag that the header chip sets for a moment when it reveals an item.
 */
export const ITEM_FRAME_CLASS =
  'flex min-w-0 flex-col rounded-xl transition-shadow duration-300 motion-reduce:transition-none data-[highlighted=true]:ring-2 data-[highlighted=true]:ring-ring';

/**
 * Same frame for a child row inside a parent card. Square: the rows share the parent's dividers, and a rounded
 * corner would curve the divider line at its ends.
 */
export const NESTED_FRAME_CLASS =
  'flex min-w-0 flex-col transition-shadow duration-300 motion-reduce:transition-none data-[highlighted=true]:ring-2 data-[highlighted=true]:ring-ring';
