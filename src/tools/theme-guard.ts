import {
  Kind,
  valueFromASTUntyped,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
} from "graphql";
import type { GraphQLClient } from "../graphql/client.js";

// Mutations that change the files of the theme named by their themeId argument
const THEME_FILE_MUTATIONS = ["themeFilesUpsert", "themeFilesDelete", "themeFilesCopy"];

/**
 * Editing the published theme changes the live storefront immediately, so writes go to a
 * duplicate unless the server was started with --allow-live-theme-writes. Returns the reason
 * to refuse the write, or null when it may go ahead.
 */
export async function liveThemeGuard(
  client: GraphQLClient,
  themeId: string,
  allowLiveThemeWrites = false
): Promise<string | null> {
  const res = await client.execute(`query ($id: ID!) { theme(id: $id) { id name role } }`, {
    id: themeId,
  });
  const theme = res.data?.theme as { name: string; role: string } | null | undefined;
  if (!theme) return `Theme ${themeId} not found`;
  if (theme.role === "MAIN" && !allowLiveThemeWrites) {
    return `"${theme.name}" is the live theme. Duplicate it with shopify_theme_duplicate, edit the copy, and publish it from the Shopify admin. To edit the live theme directly, restart the server with --allow-live-theme-writes.`;
  }
  return null;
}

/**
 * Applies the live-theme guard to a raw GraphQL document: theme file writes are checked
 * against the theme they target, and publishing a theme (which replaces the live one) is
 * refused outright. Returns the reason to refuse the document, or null.
 */
export async function rawLiveThemeGuard(
  client: GraphQLClient,
  document: DocumentNode,
  variables: Record<string, unknown> | undefined
): Promise<string | null> {
  const themeIds = new Set<string>();
  for (const field of mutationRootFields(document)) {
    const name = field.name.value;
    if (name === "themePublish") {
      return "themePublish replaces the live theme. Publish themes from the Shopify admin, or restart the server with --allow-live-theme-writes.";
    }
    if (!THEME_FILE_MUTATIONS.includes(name)) continue;

    const arg = field.arguments?.find((a) => a.name.value === "themeId");
    const themeId = arg ? valueFromASTUntyped(arg.value, variables) : undefined;
    if (typeof themeId !== "string") {
      return `Couldn't determine which theme ${name} writes to, so it can't be checked against the live theme`;
    }
    themeIds.add(themeId);
  }

  for (const themeId of themeIds) {
    const blocked = await liveThemeGuard(client, themeId);
    if (blocked) return blocked;
  }
  return null;
}

/**
 * With theme edits disabled, refuses any theme mutation: themeCreate, themeUpdate, themeDelete,
 * themeDuplicate, themePublish and the theme file writes. Returns the reason, or null.
 */
export function rawThemeWriteGuard(document: DocumentNode): string | null {
  const field = mutationRootFields(document).find((candidate) => candidate.name.value.startsWith("theme"));
  return field
    ? `${field.name.value} changes a theme, and theme edits are disabled on this server (--disable-theme-writes).`
    : null;
}

// Root fields of every mutation in the document, including those selected through fragments
function mutationRootFields(document: DocumentNode): FieldNode[] {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
  }

  const fields: FieldNode[] = [];
  const visited = new Set<string>();
  const collect = (selectionSet: SelectionSetNode) => {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        fields.push(selection);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        collect(selection.selectionSet);
      } else if (selection.kind === Kind.FRAGMENT_SPREAD && !visited.has(selection.name.value)) {
        visited.add(selection.name.value);
        const fragment = fragments.get(selection.name.value);
        if (fragment) collect(fragment.selectionSet);
      }
    }
  };

  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION && definition.operation === "mutation") {
      collect(definition.selectionSet);
    }
  }
  return fields;
}
