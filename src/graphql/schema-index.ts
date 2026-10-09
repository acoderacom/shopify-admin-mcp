import type {
  IntrospectedSchema,
  IntrospectedType,
  IntrospectedField,
  IntrospectedTypeRef,
} from "./introspection.js";

// Type details longer than this shorten their descriptions to keep the response readable
const MAX_DETAILS_LENGTH = 20_000;

type DescriptionStyle = "full" | "short" | "none";

// First sentence of a description, capped so one long sentence can't dominate
function shorten(description: string): string {
  const sentence = description.split(/(?<=\.)\s/)[0] ?? description;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

export type SchemaIndexLoader = () => Promise<SchemaIndex>;

/**
 * Builds the index on first use and shares it between callers. A failed load isn't cached,
 * so the next call tries again.
 */
export function lazySchemaIndex(load: () => Promise<IntrospectedSchema>): SchemaIndexLoader {
  let pending: Promise<SchemaIndex> | null = null;
  return () => {
    pending ??= load()
      .then((schema) => new SchemaIndex(schema))
      .catch((err: unknown) => {
        pending = null;
        throw err;
      });
    return pending;
  };
}

export class SchemaIndex {
  private typeMap: Map<string, IntrospectedType> = new Map();
  private queryFields: Map<string, IntrospectedField> = new Map();
  private mutationFields: Map<string, IntrospectedField> = new Map();
  private allNames: string[] = [];
  private queryTypeName: string;
  private mutationTypeName: string;

  constructor(schema: IntrospectedSchema) {
    this.queryTypeName = schema.queryTypeName;
    this.mutationTypeName = schema.mutationTypeName;

    for (const type of schema.types) {
      if (type.name.startsWith("__")) continue;
      this.typeMap.set(type.name, type);
    }

    const queryType = this.typeMap.get(schema.queryTypeName);
    if (queryType?.fields) {
      for (const field of queryType.fields) {
        this.queryFields.set(field.name, field);
      }
    }

    const mutationType = this.typeMap.get(schema.mutationTypeName);
    if (mutationType?.fields) {
      for (const field of mutationType.fields) {
        this.mutationFields.set(field.name, field);
      }
    }

    this.allNames = [
      ...Array.from(this.typeMap.keys()),
      ...Array.from(this.queryFields.keys()),
      ...Array.from(this.mutationFields.keys()),
    ];
  }

  search(
    keyword: string,
    filter: "all" | "types" | "queries" | "mutations" = "all",
    limit = 20
  ): { types: string[]; queries: string[]; mutations: string[] } {
    const lower = keyword.toLowerCase();

    const matchScore = (name: string): number => {
      const nameLower = name.toLowerCase();
      if (nameLower === lower) return 3;
      if (nameLower.startsWith(lower)) return 2;
      if (nameLower.includes(lower)) return 1;
      return 0;
    };

    const sortedMatch = (names: string[]): string[] =>
      names
        .map((n) => ({ name: n, score: matchScore(n) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .slice(0, limit)
        .map((x) => x.name);

    return {
      types:
        filter === "all" || filter === "types"
          ? sortedMatch(
              Array.from(this.typeMap.keys()).filter(
                (n) =>
                  !["QueryRoot", "Mutation", "Subscription"].includes(n)
              )
            )
          : [],
      queries:
        filter === "all" || filter === "queries"
          ? sortedMatch(Array.from(this.queryFields.keys()))
          : [],
      mutations:
        filter === "all" || filter === "mutations"
          ? sortedMatch(Array.from(this.mutationFields.keys()))
          : [],
    };
  }

  getType(name: string): IntrospectedType | undefined {
    return this.typeMap.get(name);
  }

  getQuery(name: string): IntrospectedField | undefined {
    return this.queryFields.get(name);
  }

  getMutation(name: string): IntrospectedField | undefined {
    return this.mutationFields.get(name);
  }

  formatTypeRef(ref: IntrospectedTypeRef): string {
    if (ref.kind === "NON_NULL") {
      return `${this.formatTypeRef(ref.ofType!)}!`;
    }
    if (ref.kind === "LIST") {
      return `[${this.formatTypeRef(ref.ofType!)}]`;
    }
    return ref.name ?? "Unknown";
  }

  formatFieldSummary(field: IntrospectedField): string {
    const args =
      field.args && field.args.length > 0
        ? `(${field.args.map((a) => `${a.name}: ${this.formatTypeRef(a.type)}`).join(", ")})`
        : "";
    return `${field.name}${args}: ${this.formatTypeRef(field.type)}`;
  }

  getDetails(name: string): string | null {
    // The root types hold every query or mutation, far too many to describe in one response
    if (name === this.queryTypeName) return this.formatRootType(name, "queries", this.queryFields);
    if (name === this.mutationTypeName) return this.formatRootType(name, "mutations", this.mutationFields);

    const type = this.typeMap.get(name);
    if (type) {
      for (const style of ["full", "short"] as const) {
        const details = this.formatType(type, style);
        if (details.length <= MAX_DETAILS_LENGTH) return details;
      }
      return `${this.formatType(type, "none")}\n\n(Descriptions omitted because ${name} has too many members to describe in one response.)`;
    }

    const query = this.queryFields.get(name);
    if (query) return this.formatFieldDetails("Query", name, query);

    const mutation = this.mutationFields.get(name);
    if (mutation) return this.formatFieldDetails("Mutation", name, mutation);

    return null;
  }

  private formatRootType(
    name: string,
    category: string,
    fields: Map<string, IntrospectedField>
  ): string {
    return [
      `# ${name} (${fields.size} ${category})`,
      "",
      `Call shopify_schema_details with one of these names for its arguments and return type, or use shopify_schema_search to narrow them down:`,
      "",
      Array.from(fields.keys()).sort().join(", "),
    ].join("\n");
  }

  private formatType(type: IntrospectedType, style: DescriptionStyle): string {
    const describe = (description: string | null) => {
      if (!description || style === "none") return "";
      return ` — ${style === "short" ? shorten(description) : description}`;
    };
    const lines: string[] = [];
    lines.push(`# ${type.name} (${type.kind})`);
    if (type.description) lines.push(`\n${type.description}`);

    if (type.interfaces && type.interfaces.length > 0) {
      lines.push(
        `\nImplements: ${type.interfaces.map((i) => this.formatTypeRef(i)).join(", ")}`
      );
    }

    if (type.fields && type.fields.length > 0) {
      lines.push("\n## Fields\n");
      for (const field of type.fields) {
        lines.push(`- ${this.formatFieldSummary(field)}${describe(field.description)}`);
      }
    }

    if (type.inputFields && type.inputFields.length > 0) {
      lines.push("\n## Input Fields\n");
      for (const field of type.inputFields) {
        const desc = describe(field.description);
        const def =
          field.defaultValue != null ? ` (default: ${field.defaultValue})` : "";
        lines.push(
          `- ${field.name}: ${this.formatTypeRef(field.type)}${def}${desc}`
        );
      }
    }

    if (type.enumValues && type.enumValues.length > 0) {
      lines.push("\n## Enum Values\n");
      for (const val of type.enumValues) {
        lines.push(`- ${val.name}${describe(val.description)}`);
      }
    }

    if (type.possibleTypes && type.possibleTypes.length > 0) {
      lines.push(
        `\nPossible Types: ${type.possibleTypes.map((t) => this.formatTypeRef(t)).join(", ")}`
      );
    }

    return lines.join("\n");
  }

  private formatFieldDetails(
    category: string,
    name: string,
    field: IntrospectedField
  ): string {
    const lines: string[] = [];
    lines.push(`# ${category}.${name}`);
    if (field.description) lines.push(`\n${field.description}`);
    lines.push(`\nReturn type: ${this.formatTypeRef(field.type)}`);

    if (field.args && field.args.length > 0) {
      lines.push("\n## Arguments\n");
      for (const arg of field.args) {
        const desc = arg.description ? ` — ${arg.description}` : "";
        const def =
          arg.defaultValue != null ? ` (default: ${arg.defaultValue})` : "";
        lines.push(
          `- ${arg.name}: ${this.formatTypeRef(arg.type)}${def}${desc}`
        );
      }
    }

    return lines.join("\n");
  }
}
