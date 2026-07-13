import type { LogicalType } from '@chronolog/ir'

import type { CanonicalJsonValue, DecimalValue, DurationMs, TimestampMs, Uuid } from './ir.js'

declare const vectorValueBrand: unique symbol
declare const decimalValueBrand: unique symbol

export type VectorValue<
  Element extends 'i8' | 'u8' | 'i16' | 'i32' | 'f32' | 'f64',
  Dimensions extends number,
  Storage extends Int8Array | Uint8Array | Int16Array | Int32Array | Float32Array | Float64Array,
> = Storage & { readonly [vectorValueBrand]: readonly [Element, Dimensions] }

export type DecimalFor<Precision extends number, Scale extends number> =
  DecimalValue & { readonly [decimalValueBrand]: readonly [Precision, Scale] }

export type CoreSchemaValue =
  | boolean
  | bigint
  | DecimalValue
  | string
  | Uint8Array
  | Uuid
  | TimestampMs
  | DurationMs
  | CanonicalJsonValue
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array

export interface GeneratedColumnDescriptor<
  Name extends string = string,
  Value = CoreSchemaValue,
  Nullable extends boolean = boolean,
> {
  readonly id: number
  readonly name: Name
  readonly declarationOrder: number
  readonly logicalType: LogicalType
  readonly nullable: Nullable
  readonly hasDefault: boolean
  readonly generated: boolean
  /** Compile-time carrier; no value is present at runtime. */
  readonly __value?: Value
}

export type GeneratedColumnMap = Readonly<Record<string, GeneratedColumnDescriptor>>

export interface GeneratedTableDescriptor<
  Name extends string = string,
  Row = Readonly<Record<string, CoreSchemaValue | null>>,
  Insert = Readonly<Record<string, CoreSchemaValue | null | undefined>>,
  Update = Readonly<Record<string, CoreSchemaValue | null | undefined>>,
  Columns extends GeneratedColumnMap = GeneratedColumnMap,
> {
  readonly id: number
  readonly name: Name
  readonly declarationOrder: number
  readonly withoutRowId: boolean
  readonly columns: Columns
  readonly primaryKey: readonly (keyof Columns & string)[]
  /** Compile-time carriers; no values are present at runtime. */
  readonly __row?: Row
  readonly __insert?: Insert
  readonly __update?: Update
}

/** Used by generated modules to retain a column's application value type. */
export function defineGeneratedColumn<Value>() {
  return <Name extends string, Nullable extends boolean>(
    descriptor: Omit<GeneratedColumnDescriptor<Name, Value, Nullable>, '__value'>,
  ): GeneratedColumnDescriptor<Name, Value, Nullable> => Object.freeze({
    ...descriptor,
    logicalType: Object.freeze({ ...descriptor.logicalType }),
  })
}

/** Used by generated modules to infer exact column keys without mutable metadata. */
export function defineGeneratedTable<Row, Insert, Update>() {
  return <Name extends string, Columns extends GeneratedColumnMap>(descriptor: {
    readonly id: number
    readonly name: Name
    readonly declarationOrder: number
    readonly withoutRowId: boolean
    readonly columns: Columns
    readonly primaryKey: readonly (keyof Columns & string)[]
  }): GeneratedTableDescriptor<Name, Row, Insert, Update, Columns> => {
    const columns = Object.freeze({ ...descriptor.columns }) as Columns
    return Object.freeze({
      ...descriptor,
      columns,
      primaryKey: Object.freeze([...descriptor.primaryKey]),
    })
  }
}
