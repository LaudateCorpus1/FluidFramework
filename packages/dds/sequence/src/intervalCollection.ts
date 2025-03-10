/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/* eslint-disable no-bitwise */

import { TypedEventEmitter } from "@fluidframework/common-utils";
import { IEvent } from "@fluidframework/common-definitions";
import * as MergeTree from "@fluidframework/merge-tree";
import { ISequencedDocumentMessage } from "@fluidframework/protocol-definitions";
import { v4 as uuid } from "uuid";
import { IValueFactory, IValueOpEmitter, IValueOperation, IValueType } from "./mapKernelInterfaces";

const reservedIntervalIdKey = "intervalId";

export interface ISerializedInterval {
    sequenceNumber: number;
    start: number;
    end: number;
    intervalType: MergeTree.IntervalType;
    properties?: MergeTree.PropertySet;
}

export interface ISerializableInterval extends MergeTree.IInterval {
    properties: MergeTree.PropertySet;
    propertyManager: MergeTree.PropertiesManager;
    serialize(client: MergeTree.Client);
    addProperties(props: MergeTree.PropertySet, collaborating?: boolean, seq?: number):
        MergeTree.PropertySet | undefined;
    getIntervalId(): string | undefined;
}

export interface IIntervalHelpers<TInterval extends ISerializableInterval> {
    compareEnds(a: TInterval, b: TInterval): number;
    create(label: string, start: number, end: number,
        client: MergeTree.Client, intervalType?: MergeTree.IntervalType): TInterval;
}

export class Interval implements ISerializableInterval {
    public properties: MergeTree.PropertySet;
    public auxProps: MergeTree.PropertySet[];
    public propertyManager: MergeTree.PropertiesManager;
    constructor(
        public start: number,
        public end: number,
        props?: MergeTree.PropertySet) {
        if (props) {
            this.addProperties(props);
        }
    }

    public getIntervalId(): string | undefined {
        const id = this.properties?.[reservedIntervalIdKey];
        if (id === undefined) {
            return undefined;
        }
        return `${id}`;
    }

    public getAdditionalPropertySets() {
        return this.auxProps;
    }

    public addPropertySet(props: MergeTree.PropertySet) {
        if (this.auxProps === undefined) {
            this.auxProps = [];
        }
        this.auxProps.push(props);
    }

    public serialize(client: MergeTree.Client) {
        let seq = 0;
        if (client) {
            seq = client.getCurrentSeq();
        }

        const serializedInterval: ISerializedInterval = {
            end: this.end,
            intervalType: 0,
            sequenceNumber: seq,
            start: this.start,
        };
        if (this.properties) {
            serializedInterval.properties = this.properties;
        }
        return serializedInterval;
    }

    public clone() {
        return new Interval(this.start, this.end, this.properties);
    }

    public compare(b: Interval) {
        const startResult = this.compareStart(b);
        if (startResult === 0) {
            const endResult = this.compareEnd(b);
            if (endResult === 0) {
                const thisId = this.getIntervalId();
                if (thisId) {
                    const bId = b.getIntervalId();
                    if (bId) {
                        return thisId > bId ? 1 : thisId < bId ? -1 : 0;
                    }
                    return 0;
                }
                return 0;
            }
            else {
                return endResult;
            }
        } else {
            return startResult;
        }
    }

    public compareStart(b: Interval) {
        return this.start - b.start;
    }

    public compareEnd(b: Interval) {
        return this.end - b.end;
    }

    public overlaps(b: Interval) {
        const result = (this.start < b.end) &&
            (this.end >= b.start);
        return result;
    }

    public union(b: Interval) {
        return new Interval(Math.min(this.start, b.start),
            Math.max(this.end, b.end), this.properties);
    }

    public getProperties() {
        return this.properties;
    }

    public addProperties(
        newProps: MergeTree.PropertySet,
        collaborating: boolean = false,
        seq?: number,
        op?: MergeTree.ICombiningOp,
    ): MergeTree.PropertySet | undefined {
        if (newProps) {
            if (!this.propertyManager) {
                this.propertyManager = new MergeTree.PropertiesManager();
            }
            if (!this.properties) {
                this.properties = MergeTree.createMap<any>();
            }
            return this.propertyManager.addProperties(this.properties, newProps, op, seq, collaborating);
        }
    }

    public modify(label: string, start: number, end: number) {
        const startPos = start ?? this.start;
        const endPos = end ?? this.end;
        if (this.start === startPos && this.end === endPos) {
            // Return undefined to indicate that no change is necessary.
            return;
        }
        return new Interval(startPos, endPos, this.properties);
    }
}

export class SequenceInterval implements ISerializableInterval {
    public properties: MergeTree.PropertySet;
    public propertyManager: MergeTree.PropertiesManager;
    private readonly checkMergeTree: MergeTree.MergeTree;

    constructor(
        public start: MergeTree.LocalReference,
        public end: MergeTree.LocalReference,
        public intervalType: MergeTree.IntervalType,
        props?: MergeTree.PropertySet) {
        if (props) {
            this.addProperties(props);
        }
    }

    public serialize(client: MergeTree.Client) {
        const startPosition = this.start.toPosition();
        const endPosition = this.end.toPosition();
        const serializedInterval: ISerializedInterval = {
            end: endPosition,
            intervalType: this.intervalType,
            sequenceNumber: client.getCurrentSeq(),
            start: startPosition,
        };
        if (this.properties) {
            serializedInterval.properties = this.properties;
        }
        return serializedInterval;
    }

    public clone() {
        return new SequenceInterval(this.start, this.end, this.intervalType, this.properties);
    }

    public compare(b: SequenceInterval) {
        const startResult = this.compareStart(b);
        if (startResult === 0) {
            const endResult = this.compareEnd(b);
            if (endResult === 0) {
                const thisId = this.getIntervalId();
                if (thisId) {
                    const bId = b.getIntervalId();
                    if (bId) {
                        return thisId > bId ? 1 : thisId < bId ? -1 : 0;
                    }
                    return 0;
                }
                return 0;
            }
            else {
                return endResult;
            }
        } else {
            return startResult;
        }
    }

    public compareStart(b: SequenceInterval) {
        return this.start.compare(b.start);
    }

    public compareEnd(b: SequenceInterval) {
        return this.end.compare(b.end);
    }

    public overlaps(b: SequenceInterval) {
        const result = (this.start.compare(b.end) < 0) &&
            (this.end.compare(b.start) >= 0);
        if (this.checkMergeTree) {
            this.checkOverlaps(b, result);
        }
        return result;
    }

    public getIntervalId(): string | undefined {
        const id = this.properties?.[reservedIntervalIdKey];
        if (id === undefined) {
            return undefined;
        }
        return `${id}`;
    }

    public union(b: SequenceInterval) {
        return new SequenceInterval(this.start.min(b.start),
            this.end.max(b.end), this.intervalType);
    }

    public addProperties(
        newProps: MergeTree.PropertySet,
        collab: boolean = false,
        seq?: number,
        op?: MergeTree.ICombiningOp,
    ): MergeTree.PropertySet | undefined {
        if (!this.propertyManager) {
            this.propertyManager = new MergeTree.PropertiesManager();
        }
        if (!this.properties) {
            this.properties = MergeTree.createMap<any>();
        }
        return this.propertyManager.addProperties(this.properties, newProps, op, seq, collab);
    }

    public overlapsPos(bstart: number, bend: number) {
        const startPos = this.start.toPosition();
        const endPos = this.start.toPosition();
        return (endPos > bstart) && (startPos < bend);
    }

    private checkOverlaps(b: SequenceInterval, result: boolean) {
        const astart = this.start.toPosition();
        const bstart = b.start.toPosition();
        const aend = this.end.toPosition();
        const bend = b.end.toPosition();
        const checkResult = ((astart < bend) && (bstart < aend));
        if (checkResult !== result) {
            // eslint-disable-next-line max-len
            console.log(`check mismatch: res ${result} ${this.start.segment === b.end.segment} ${b.start.segment === this.end.segment}`);
            console.log(`as ${astart} ae ${aend} bs ${bstart} be ${bend}`);
            console.log(`as ${MergeTree.ordinalToArray(this.start.segment.ordinal)}@${this.start.offset}`);
            console.log(`ae ${MergeTree.ordinalToArray(this.end.segment.ordinal)}@${this.end.offset}`);
            console.log(`bs ${MergeTree.ordinalToArray(b.start.segment.ordinal)}@${b.start.offset}`);
            console.log(`be ${MergeTree.ordinalToArray(b.end.segment.ordinal)}@${b.end.offset}`);
            console.log(this.checkMergeTree.nodeToString(b.start.segment.parent, ""));
        }
    }

    public modify(label: string, start: number, end: number) {
        const startPos = start ?? this.start.getOffset();
        const endPos = end ?? this.end.getOffset();

        if (this.start.getOffset() === startPos && this.end.getOffset() === endPos) {
            // Return undefined to indicate that no change is necessary.
            return;
        }

        const newInterval = createSequenceInterval(label, startPos, endPos, this.start.getClient(), this.intervalType);
        if (this.properties) {
            newInterval.addProperties(this.properties);
        }
        return newInterval;
    }
}

function createPositionReference(
    client: MergeTree.Client,
    pos: number,
    refType: MergeTree.ReferenceType): MergeTree.LocalReference {
    const segoff = client.getContainingSegment(pos);
    if (segoff && segoff.segment) {
        const lref = new MergeTree.LocalReference(client, segoff.segment, segoff.offset, refType);
        if (refType !== MergeTree.ReferenceType.Transient) {
            client.addLocalReference(lref);
        }
        return lref;
    }
    return new MergeTree.LocalReference(client, undefined);
}

function createSequenceInterval(
    label: string,
    start: number,
    end: number,
    client: MergeTree.Client,
    intervalType: MergeTree.IntervalType): SequenceInterval {
    let beginRefType = MergeTree.ReferenceType.RangeBegin;
    let endRefType = MergeTree.ReferenceType.RangeEnd;
    if (intervalType === MergeTree.IntervalType.Nest) {
        beginRefType = MergeTree.ReferenceType.NestBegin;
        endRefType = MergeTree.ReferenceType.NestEnd;
    } else if (intervalType === MergeTree.IntervalType.Transient) {
        beginRefType = MergeTree.ReferenceType.Transient;
        endRefType = MergeTree.ReferenceType.Transient;
    }

    // TODO: Should SlideOnRemove be the default behavior?
    if (intervalType & MergeTree.IntervalType.SlideOnRemove) {
        beginRefType |= MergeTree.ReferenceType.SlideOnRemove;
        endRefType |= MergeTree.ReferenceType.SlideOnRemove;
    }

    const startLref = createPositionReference(client, start, beginRefType);
    const endLref = createPositionReference(client, end, endRefType);
    if (startLref && endLref) {
        startLref.pairedRef = endLref;
        endLref.pairedRef = startLref;
        const rangeProp = {
            [MergeTree.reservedRangeLabelsKey]: [label],
        };
        startLref.addProperties(rangeProp);
        endLref.addProperties(rangeProp);

        const ival = new SequenceInterval(startLref, endLref, intervalType, rangeProp);
        return ival;
    }
}

export function defaultIntervalConflictResolver(a: Interval, b: Interval) {
    a.addPropertySet(b.properties);
    return a;
}

export function createIntervalIndex(conflict?: MergeTree.IntervalConflictResolver<Interval>) {
    const helpers: IIntervalHelpers<Interval> = {
        compareEnds: compareIntervalEnds,
        create: createInterval,
    };
    const lc = new LocalIntervalCollection<Interval>(undefined, "", helpers);
    if (conflict) {
        lc.addConflictResolver(conflict);
    } else {
        lc.addConflictResolver(defaultIntervalConflictResolver);
    }
    return lc;
}

export class LocalIntervalCollection<TInterval extends ISerializableInterval> {
    private readonly intervalTree = new MergeTree.IntervalTree<TInterval>();
    private readonly endIntervalTree: MergeTree.RedBlackTree<TInterval, TInterval>;
    private conflictResolver: MergeTree.IntervalConflictResolver<TInterval>;
    private endConflictResolver: MergeTree.ConflictAction<TInterval, TInterval>;

    private static readonly legacyIdPrefix = "legacy";

    constructor(
        private readonly client: MergeTree.Client,
        private readonly label: string,
        private readonly helpers: IIntervalHelpers<TInterval>) {
        this.endIntervalTree =
            // eslint-disable-next-line @typescript-eslint/unbound-method
            new MergeTree.RedBlackTree<TInterval, TInterval>(helpers.compareEnds);
    }

    public addConflictResolver(conflictResolver: MergeTree.IntervalConflictResolver<TInterval>) {
        this.conflictResolver = conflictResolver;
        this.endConflictResolver =
            (key: TInterval, currentKey: TInterval) => {
                const ival = this.conflictResolver(key, currentKey);
                return {
                    data: ival,
                    key: ival,
                };
            };
    }

    public map(fn: (interval: TInterval) => void) {
        this.intervalTree.map(fn);
    }

    public createLegacyId(start: number, end: number): string {
        // Create a non-unique ID based on start and end to be used on intervals that come from legacy clients
        // without ID's.
        return `${LocalIntervalCollection.legacyIdPrefix}${start}-${end}`;
    }

    public ensureSerializedId(serializedInterval: ISerializedInterval) {
        if (serializedInterval.properties?.[reservedIntervalIdKey] === undefined) {
            // An interval came over the wire without an ID, so create a non-unique one based on start/end.
            // This will allow all clients to refer to this interval consistently.
            const newProps = {
                [reservedIntervalIdKey]: this.createLegacyId(serializedInterval.start, serializedInterval.end),
            };
            serializedInterval.properties = MergeTree.addProperties(serializedInterval.properties, newProps);
        }
        // Make the ID immutable for safety's sake.
        Object.defineProperty(serializedInterval.properties, reservedIntervalIdKey, {
            configurable: false,
            enumerable: true,
            writable: false,
        });
    }

    public mapUntil(fn: (interval: TInterval) => boolean) {
        this.intervalTree.mapUntil(fn);
    }

    public gatherIterationResults(
        results: TInterval[],
        iteratesForward: boolean,
        start?: number,
        end?: number) {
        if (this.intervalTree.intervals.isEmpty()) {
            return;
        }

        if (start === undefined && end === undefined) {
            // No start/end provided. Gather the whole tree in the specified order.
            if (iteratesForward) {
                this.intervalTree.map((interval: TInterval) => {
                    results.push(interval);
                });
            }
            else {
                this.intervalTree.mapBackward((interval: TInterval) => {
                    results.push(interval);
                });
            }
        }
        else {
            const transientInterval: TInterval = this.helpers.create(
                "transient",
                start,
                end,
                this.client,
                MergeTree.IntervalType.Transient,
            );

            if (start === undefined) {
                // Only end position provided. Since the tree is not sorted by end position,
                // walk the whole tree in the specified order, gathering intervals that match the end.
                if (iteratesForward) {
                    this.intervalTree.map((interval: TInterval) => {
                        if (transientInterval.compareEnd(interval) === 0) {
                            results.push(interval);
                        }
                    });
                }
                else {
                    this.intervalTree.mapBackward((interval: TInterval) => {
                        if (transientInterval.compareEnd(interval) === 0) {
                            results.push(interval);
                        }
                    });
                }
            }
            else {
                // Start and (possibly) end provided. Walk the subtrees that may contain
                // this start position.
                const compareFn =
                    end === undefined ?
                        (node: MergeTree.IntervalNode<TInterval>) => {
                            return transientInterval.compareStart(node.key);
                        } :
                        (node: MergeTree.IntervalNode<TInterval>) => {
                            return transientInterval.compare(node.key);
                        };
                const continueLeftFn = (cmpResult: number) => cmpResult <= 0;
                const continueRightFn = (cmpResult: number) => cmpResult >= 0;
                const actionFn = (node: MergeTree.IntervalNode<TInterval>) => {
                    results.push(node.key);
                };

                if (iteratesForward) {
                    this.intervalTree.intervals.walkExactMatchesForward(
                        compareFn, actionFn, continueLeftFn, continueRightFn,
                    );
                }
                else {
                    this.intervalTree.intervals.walkExactMatchesBackward(
                        compareFn, actionFn, continueLeftFn, continueRightFn,
                    );
                }
            }
        }
    }

    public findOverlappingIntervals(startPosition: number, endPosition: number) {
        if (!this.intervalTree.intervals.isEmpty()) {
            const transientInterval =
                this.helpers.create(
                    "transient",
                    startPosition,
                    endPosition,
                    this.client,
                    MergeTree.IntervalType.Transient);

            const overlappingIntervalNodes = this.intervalTree.match(transientInterval);
            return overlappingIntervalNodes.map((node) => node.key);
        } else {
            return [];
        }
    }

    public previousInterval(pos: number) {
        const transientInterval = this.helpers.create(
            "transient", pos, pos, this.client, MergeTree.IntervalType.Transient);
        const rbNode = this.endIntervalTree.floor(transientInterval);
        if (rbNode) {
            return rbNode.data;
        }
    }

    public nextInterval(pos: number) {
        const transientInterval = this.helpers.create(
            "transient", pos, pos, this.client, MergeTree.IntervalType.Transient);
        const rbNode = this.endIntervalTree.ceil(transientInterval);
        if (rbNode) {
            return rbNode.data;
        }
    }

    public removeInterval(startPosition: number, endPosition: number) {
        const transientInterval = this.helpers.create(
            "transient", startPosition, endPosition, this.client, MergeTree.IntervalType.Transient);
        this.intervalTree.remove(transientInterval);
        this.endIntervalTree.remove(transientInterval);
        return transientInterval;
    }

    public removeExistingInterval(interval: TInterval) {
        this.intervalTree.removeExisting(interval);
        this.endIntervalTree.remove(interval);
    }

    public createInterval(start: number, end: number, intervalType: MergeTree.IntervalType): TInterval {
        return this.helpers.create(this.label, start, end, this.client, intervalType);
    }

    public addInterval(
        start: number,
        end: number,
        intervalType: MergeTree.IntervalType,
        props?: MergeTree.PropertySet) {
        const interval: TInterval = this.createInterval(start, end, intervalType);
        if (interval) {
            if (!interval.properties) {
                interval.properties = MergeTree.createMap<any>();
            }
            if (props) {
                interval.addProperties(props);
            }
            if (interval.properties[reservedIntervalIdKey] === undefined) {
                // Create a new ID.
                interval.properties[reservedIntervalIdKey] = uuid();
            }
            // Make the ID immutable.
            Object.defineProperty(interval.properties, reservedIntervalIdKey, {
                configurable: false,
                enumerable: true,
                writable: false,
            });
            this.add(interval);
        }
        return interval;
    }

    public add(interval: TInterval) {
        this.intervalTree.put(interval, this.conflictResolver);
        this.endIntervalTree.put(interval, interval, this.endConflictResolver);
    }

    public getIntervalById(id: string) {
        let result: TInterval | undefined;
        this.mapUntil((interval: TInterval) => {
            if (interval.getIntervalId() === id) {
                result = interval;
                return false;
            }
            return true;
        });
        return result;
    }

    public changeInterval(interval: TInterval, start: number, end: number) {
        const newInterval: TInterval = interval.modify(this.label, start, end);
        if (newInterval) {
            this.removeExistingInterval(interval);
            this.add(newInterval);
        }
        return newInterval;
    }

    public serialize() {
        const client = this.client;
        const intervals = this.intervalTree.intervals.keys();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return intervals.map((interval) => interval.serialize(client));
    }

    /**
     * @deprecated This method only exists to support the deprecated IntervalCollection.delete(start, end).
     */
    public getLegacyInterval(start: number, end: number): TInterval | undefined {
        const transientInterval: TInterval = this.helpers.create(
            "transient",
            start,
            end,
            this.client,
            MergeTree.IntervalType.Transient,
        );

        let result: TInterval;
        this.mapUntil((interval: TInterval): boolean => {
            if (interval.compareStart(transientInterval) === 0 &&
                interval.compareEnd(transientInterval) === 0 &&
                interval.getIntervalId()?.startsWith(LocalIntervalCollection.legacyIdPrefix)) {
                result = interval;
                return false;
            }
            return true;
        });
        return result;
    }
}

const compareSequenceIntervalEnds = (a: SequenceInterval, b: SequenceInterval): number => a.end.compare(b.end);

class SequenceIntervalCollectionFactory
    implements IValueFactory<IntervalCollection<SequenceInterval>> {
    public load(
        emitter: IValueOpEmitter,
        raw: ISerializedInterval[] = [],
    ): IntervalCollection<SequenceInterval> {
        const helpers: IIntervalHelpers<SequenceInterval> = {
            compareEnds: compareSequenceIntervalEnds,
            create: createSequenceInterval,
        };
        return new IntervalCollection<SequenceInterval>(helpers, true, emitter, raw);
    }

    public store(value: IntervalCollection<SequenceInterval>): ISerializedInterval[] {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return value.serializeInternal();
    }
}

export class SequenceIntervalCollectionValueType
    implements IValueType<IntervalCollection<SequenceInterval>> {
    public static Name = "sharedStringIntervalCollection";

    public get name(): string {
        return SequenceIntervalCollectionValueType.Name;
    }

    public get factory(): IValueFactory<IntervalCollection<SequenceInterval>> {
        return SequenceIntervalCollectionValueType._factory;
    }

    public get ops(): Map<string, IValueOperation<IntervalCollection<SequenceInterval>>> {
        return SequenceIntervalCollectionValueType._ops;
    }

    private static readonly _factory: IValueFactory<IntervalCollection<SequenceInterval>> =
        new SequenceIntervalCollectionFactory();

    private static readonly _ops: Map<string, IValueOperation<IntervalCollection<SequenceInterval>>> =
        new Map<string, IValueOperation<IntervalCollection<SequenceInterval>>>(
            [[
                "add",
                {
                    process: (value, params, local, op) => {
                        // Local ops were applied when the message was created
                        if (local) {
                            return;
                        }

                        value.addInternal(params, local, op);
                    },
                },
            ],
            [
                "delete",
                {
                    process: (value, params, local, op) => {
                        if (local) {
                            return;
                        }
                        value.deleteInterval(params, local, op);
                    },
                },
            ],
            [
                "change",
                {
                    process: (value, params, local, op) => {
                        value.changeInterval(params, local, op);
                    },
                },
            ]]);
}

const compareIntervalEnds = (a: Interval, b: Interval) => a.end - b.end;

function createInterval(label: string, start: number, end: number, client: MergeTree.Client): Interval {
    let rangeProp: MergeTree.PropertySet;
    if (label && (label.length > 0)) {
        rangeProp = {
            [MergeTree.reservedRangeLabelsKey]: [label],
        };
    }
    return new Interval(start, end, rangeProp);
}

class IntervalCollectionFactory
    implements IValueFactory<IntervalCollection<Interval>> {
    public load(emitter: IValueOpEmitter, raw: ISerializedInterval[] = []): IntervalCollection<Interval> {
        const helpers: IIntervalHelpers<Interval> = {
            compareEnds: compareIntervalEnds,
            create: createInterval,
        };
        const collection = new IntervalCollection<Interval>(helpers, false, emitter, raw);
        collection.attachGraph(undefined, "");
        return collection;
    }

    public store(value: IntervalCollection<Interval>): ISerializedInterval[] {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return value.serializeInternal();
    }
}

export class IntervalCollectionValueType
    implements IValueType<IntervalCollection<Interval>> {
    public static Name = "sharedIntervalCollection";

    public get name(): string {
        return IntervalCollectionValueType.Name;
    }

    public get factory(): IValueFactory<IntervalCollection<Interval>> {
        return IntervalCollectionValueType._factory;
    }

    public get ops(): Map<string, IValueOperation<IntervalCollection<Interval>>> {
        return IntervalCollectionValueType._ops;
    }

    private static readonly _factory: IValueFactory<IntervalCollection<Interval>> =
        new IntervalCollectionFactory();
    private static readonly _ops: Map<string, IValueOperation<IntervalCollection<Interval>>> =
        new Map<string, IValueOperation<IntervalCollection<Interval>>>(
            [[
                "add",
                {
                    process: (value, params, local, op) => {
                        // Local ops were applied when the message was created
                        if (local) {
                            return;
                        }

                        value.addInternal(params, local, op);
                    },
                },
            ],
            [
                "delete",
                {
                    process: (value, params, local, op) => {
                        if (local) {
                            return;
                        }
                        value.deleteInterval(params, local, op);
                    },
                },
            ],
            [
                "change",
                {
                    process: (value, params, local, op) => {
                        value.changeInterval(params, local, op);
                    },
                },
            ]]);
}

export type DeserializeCallback = (properties: MergeTree.PropertySet) => void;

export class IntervalCollectionIterator<TInterval extends ISerializableInterval> {
    private readonly results: TInterval[];
    private index: number;

    constructor(
        collection: IntervalCollection<TInterval>,
        iteratesForward: boolean = true,
        start?: number,
        end?: number) {
        this.results = [];
        this.index = 0;

        collection.gatherIterationResults(this.results, iteratesForward, start, end);
    }

    public next() {
        let _value: TInterval | undefined;
        let _done: boolean = true;

        if (this.index < this.results.length) {
            _value = this.results[this.index++];
            _done = false;
        }

        return {
            value: _value,
            done: _done,
        };
    }
}

export interface IIntervalCollectionEvent<TInterval extends ISerializableInterval> extends IEvent {
    (event: "addInterval" | "deleteInterval",
        listener: (interval: TInterval, local: boolean, op: ISequencedDocumentMessage) => void);
    (event: "propertyChanged", listener: (interval: TInterval, propertyArgs: MergeTree.PropertySet) => void);
}

export class IntervalCollection<TInterval extends ISerializableInterval>
    extends TypedEventEmitter<IIntervalCollectionEvent<TInterval>> {
    private savedSerializedIntervals?: ISerializedInterval[];
    private localCollection: LocalIntervalCollection<TInterval>;
    private onDeserialize: DeserializeCallback;
    private client: MergeTree.Client;
    private pendingChangeStart: Map<string, ISerializedInterval[]>;
    private pendingChangeEnd: Map<string, ISerializedInterval[]>;

    public get attached(): boolean {
        return !!this.localCollection;
    }

    constructor(private readonly helpers: IIntervalHelpers<TInterval>, private readonly requiresClient: boolean,
        private readonly emitter: IValueOpEmitter,
        serializedIntervals: ISerializedInterval[]) {
        super();
        this.savedSerializedIntervals = serializedIntervals;
    }

    public attachGraph(client: MergeTree.Client, label: string) {
        if (this.attached) {
            throw new Error("Only supports one Sequence attach");
        }

        if ((client === undefined) && (this.requiresClient)) {
            throw new Error("Client required for this collection");
        }

        // Instantiate the local interval collection based on the saved intervals
        this.client = client;
        this.localCollection = new LocalIntervalCollection<TInterval>(client, label, this.helpers);
        if (this.savedSerializedIntervals) {
            for (const serializedInterval of this.savedSerializedIntervals) {
                this.localCollection.ensureSerializedId(serializedInterval);
                this.localCollection.addInterval(
                    serializedInterval.start,
                    serializedInterval.end,
                    serializedInterval.intervalType,
                    serializedInterval.properties);
            }
        }
        this.savedSerializedIntervals = undefined;
    }

    public getIntervalById(id: string) {
        if (!this.attached) {
            throw new Error("attach must be called before accessing intervals");
        }
        return this.localCollection.getIntervalById(id);
    }

    public add(
        start: number,
        end: number,
        intervalType: MergeTree.IntervalType,
        props?: MergeTree.PropertySet,
    ) {
        if (!this.attached) {
            throw new Error("attach must be called prior to adding intervals");
        }

        const interval: TInterval = this.localCollection.addInterval(start, end, intervalType, props);

        if (interval) {
            const serializedInterval = {
                end,
                intervalType,
                properties: interval.properties,
                sequenceNumber: this.client?.getCurrentSeq() ?? 0,
                start,
            };
            // Local ops get submitted to the server. Remote ops have the deserializer run.
            this.emitter.emit("add", undefined, serializedInterval);
        }

        this.emit("addInterval", interval, true, undefined);

        return interval;
    }

    /**
     * @deprecated delete by start/end position is deprecated. Use removeIntervalById.
     */
    public delete(
        start: number,
        end: number,
    ) {
        if (!this.attached) {
            throw new Error("attach must be called prior to deleting intervals");
        }

        const interval = this.localCollection.getLegacyInterval(start, end);
        if (interval) {
            this.deleteExistingInterval(interval, true, undefined);
        }
    }

    private deleteExistingInterval(interval: TInterval, local: boolean, op: ISequencedDocumentMessage) {
        // The given interval is known to exist in the collection.
        this.localCollection.removeExistingInterval(interval);
        if (interval) {
            // Local ops get submitted to the server. Remote ops have the deserializer run.
            if (local) {
                this.emitter.emit("delete", undefined, interval.serialize(this.client));
            } else {
                if (this.onDeserialize) {
                    this.onDeserialize(interval);
                }
            }
        }

        this.emit("deleteInterval", interval, local, op);
    }

    public removeIntervalById(id: string) {
        const interval = this.localCollection.getIntervalById(id);
        if (interval) {
            this.deleteExistingInterval(interval, true, undefined);
        }
        return interval;
    }

    public changeProperties(id: string, props: MergeTree.PropertySet) {
        if (!this.attached) {
            throw new Error("Attach must be called before accessing intervals");
        }
        if (typeof(id) !== "string") {
            throw new Error("Change API requires an ID that is a string");
        }
        if (!props) {
            throw new Error("changeProperties should be called with a property set");
        }

        const interval = this.getIntervalById(id);
        if (interval) {
            // Pass Unassigned as the sequence number to indicate that this is a local op that is waiting for an ack.
            const deltaProps = interval.addProperties(props, true, MergeTree.UnassignedSequenceNumber);
            const serializedInterval: ISerializedInterval = interval.serialize(this.client);
            // Emit a change op that will only change properties. Add the ID to the property bag provided by the caller.
            serializedInterval.start = undefined;
            serializedInterval.end = undefined;
            serializedInterval.properties = props;
            serializedInterval.properties[reservedIntervalIdKey] = interval.getIntervalId();
            this.emitter.emit("change", undefined, serializedInterval);
            this.emit("propertyChanged", interval, deltaProps);
        }
        this.emit("change", interval, true, undefined);
    }

    public change(id: string, start?: number, end?: number): TInterval | undefined {
        if (!this.attached) {
            throw new Error("Attach must be called before accessing intervals");
        }
        if (typeof(id) !== "string") {
            throw new Error("Change API requires an ID that is a string");
        }

        // Force id to be a string.
        const interval = this.getIntervalById(id);
        if (interval) {
            this.localCollection.changeInterval(interval, start, end);
            const serializedInterval: ISerializedInterval = interval.serialize(this.client);
            serializedInterval.start = start;
            serializedInterval.end = end;
            // Emit a property bag containing only the ID, as we don't intend for this op to change any properties.
            serializedInterval.properties =
                {
                    [reservedIntervalIdKey]: interval.getIntervalId(),
                };
            this.emitter.emit("change", undefined, serializedInterval);
            this.addPendingChange(id, serializedInterval);
        }
        this.emit("change", interval, true, undefined);
        return interval;
    }

    private addPendingChange(id: string, serializedInterval: ISerializedInterval) {
        if (serializedInterval.start !== undefined) {
            if (!this.pendingChangeStart) {
                this.pendingChangeStart = new Map<string, ISerializedInterval[]>();
            }
            this.addPendingChangeHelper(id, this.pendingChangeStart, serializedInterval);
        }
        if (serializedInterval.end !== undefined) {
            if (!this.pendingChangeEnd) {
                this.pendingChangeEnd = new Map<string, ISerializedInterval[]>();
            }
            this.addPendingChangeHelper(id, this.pendingChangeEnd, serializedInterval);
        }
    }

    private addPendingChangeHelper(
        id: string,
        pendingChanges: Map<string, ISerializedInterval[]>,
        serializedInterval: ISerializedInterval,
    ) {
        let entries: ISerializedInterval[] = pendingChanges.get(id);
        if (!entries) {
            entries = [];
            pendingChanges.set(id, entries);
        }
        entries.push(serializedInterval);
    }

    private removePendingChange(serializedInterval: ISerializedInterval) {
        // Change ops always have an ID.
        const id: string = serializedInterval.properties[reservedIntervalIdKey];
        if (serializedInterval.start !== undefined) {
            this.removePendingChangeHelper(id, this.pendingChangeStart, serializedInterval);
        }
        if (serializedInterval.end !== undefined) {
            this.removePendingChangeHelper(id, this.pendingChangeEnd, serializedInterval);
        }
    }

    private removePendingChangeHelper(
        id: string,
        pendingChanges: Map<string, ISerializedInterval[]>,
        serializedInterval: ISerializedInterval,
    ) {
        const entries = pendingChanges?.get(id);
        if (entries) {
            const pendingChange = entries.shift();
            if (entries.length === 0) {
                pendingChanges.delete(id);
            }
            if (pendingChange.start !== serializedInterval.start ||
                pendingChange.end !== serializedInterval.end) {
                throw new Error("Mismatch in pending changes");
            }
        }
    }

    private hasPendingChangeStart(id: string) {
        const entries = this.pendingChangeStart?.get(id);
        return entries && entries.length !== 0;
    }

    private hasPendingChangeEnd(id: string) {
        const entries = this.pendingChangeEnd?.get(id);
        return entries && entries.length !== 0;
    }

    public changeInterval(serializedInterval: ISerializedInterval, local: boolean, op: ISequencedDocumentMessage) {
        if (!this.attached) {
            throw new Error("Attach must be called before accessing intervals");
        }

        if (local) {
            // This is an ack from the server. Remove the pending change.
            this.removePendingChange(serializedInterval);
            const id: string = serializedInterval.properties[reservedIntervalIdKey];
            const interval: TInterval = this.getIntervalById(id);
            if (interval) {
                // Let the propertyManager prune its pending change-properties set.
                interval.propertyManager?.ackPendingProperties(
                    {
                        type: MergeTree.MergeTreeDeltaType.ANNOTATE,
                        props: serializedInterval.properties,
                    });
            }
        }
        else {
            // If there are pending changes with this ID, don't apply the remote start/end change, as the local ack
            // should be the winning change.
            const id: string = serializedInterval.properties[reservedIntervalIdKey];
            let interval: TInterval = this.getIntervalById(id);
            if (interval) {
                let start: number | undefined;
                let end: number | undefined;
                // Track pending start/end independently of one another.
                if (!this.hasPendingChangeStart(id)) {
                    start = serializedInterval.start;
                }
                if (!this.hasPendingChangeEnd(id)) {
                    end = serializedInterval.end;
                }
                if (start !== undefined || end !== undefined) {
                    // If changeInterval gives us a new interval, work with that one. Otherwise keep working with
                    // the one we originally found in the tree.
                    interval = this.localCollection.changeInterval(interval, start, end) ?? interval;
                }
                const deltaProps = interval.addProperties(serializedInterval.properties, true, op.sequenceNumber);
                if (this.onDeserialize) {
                    this.onDeserialize(interval);
                }
                this.emit("propertyChanged", interval, deltaProps);
            }
            this.emit("changeInterval", interval, local, op);
        }
    }

    public addConflictResolver(conflictResolver: MergeTree.IntervalConflictResolver<TInterval>): void {
        if (!this.attached) {
            throw new Error("attachSequence must be called");
        }
        this.localCollection.addConflictResolver(conflictResolver);
    }

    public attachDeserializer(onDeserialize: DeserializeCallback): void {
        // If no deserializer is specified can skip all processing work
        if (!onDeserialize) {
            return;
        }

        // Start by storing the callbacks so that any subsequent modifications make use of them
        this.onDeserialize = onDeserialize;

        // Trigger the async prepare work across all values in the collection
        this.localCollection.map((interval) => {
            this.onDeserialize(interval);
        });
    }

    /**
     * @deprecated IntervalCollectionView has been removed. Refer to IntervalCollection directly.
     */
    public async getView(onDeserialize?: DeserializeCallback): Promise<IntervalCollection<TInterval>> {
        if (!this.attached) {
            return Promise.reject(new Error("attachSequence must be called prior to retrieving the view"));
        }

        // Attach custom deserializers if specified
        if (onDeserialize) {
            this.attachDeserializer(onDeserialize);
        }

        return this;
    }

    public addInternal(
        serializedInterval: ISerializedInterval,
        local: boolean,
        op: ISequencedDocumentMessage) {
        if (!this.attached) {
            throw new Error("attachSequence must be called");
        }

        this.localCollection.ensureSerializedId(serializedInterval);

        const interval: TInterval = this.localCollection.addInterval(
            serializedInterval.start,
            serializedInterval.end,
            serializedInterval.intervalType,
            serializedInterval.properties);

        if (interval) {
            // Local ops get submitted to the server. Remote ops have the deserializer run.
            if (local) {
                // Review: Is this case possible?
                this.emitter.emit("add", undefined, serializedInterval);
            } else {
                if (this.onDeserialize) {
                    this.onDeserialize(interval);
                }
            }
        }

        this.emit("addInterval", interval, local, op);

        return interval;
    }

    public deleteInterval(
        serializedInterval: ISerializedInterval,
        local: boolean,
        op: ISequencedDocumentMessage): void {
        if (!this.attached) {
            throw new Error("attach must be called prior to deleting intervals");
        }

        this.localCollection.ensureSerializedId(serializedInterval);
        const interval = this.localCollection.getIntervalById(serializedInterval.properties[reservedIntervalIdKey]);
        if (interval) {
            this.deleteExistingInterval(interval, local, op);
        }
    }

    public serializeInternal() {
        if (!this.attached) {
            throw new Error("attachSequence must be called");
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return this.localCollection.serialize();
    }

    public [Symbol.iterator](): IntervalCollectionIterator<TInterval> {
        const iterator = new IntervalCollectionIterator<TInterval>(this);
        return iterator;
    }

    public CreateForwardIteratorWithStartPosition(startPosition: number): IntervalCollectionIterator<TInterval> {
        const iterator = new IntervalCollectionIterator<TInterval>(this, true, startPosition);
        return iterator;
    }

    public CreateBackwardIteratorWithStartPosition(startPosition: number): IntervalCollectionIterator<TInterval> {
        const iterator = new IntervalCollectionIterator<TInterval>(this, false, startPosition);
        return iterator;
    }

    public CreateForwardIteratorWithEndPosition(endPosition: number): IntervalCollectionIterator<TInterval> {
        const iterator = new IntervalCollectionIterator<TInterval>(this, true, undefined, endPosition);
        return iterator;
    }

    public CreateBackwardIteratorWithEndPosition(endPosition: number): IntervalCollectionIterator<TInterval> {
        const iterator = new IntervalCollectionIterator<TInterval>(this, false, undefined, endPosition);
        return iterator;
    }

    public gatherIterationResults(
        results: TInterval[],
        iteratesForward: boolean,
        start?: number,
        end?: number) {
        if (!this.attached) {
            return;
        }

        this.localCollection.gatherIterationResults(results, iteratesForward, start, end);
    }

    public findOverlappingIntervals(startPosition: number, endPosition: number): TInterval[] {
        if (!this.attached) {
            throw new Error("attachSequence must be called");
        }

        return this.localCollection.findOverlappingIntervals(startPosition, endPosition);
    }

    public map(fn: (interval: TInterval) => void) {
        if (!this.attached) {
            throw new Error("attachSequence must be called");
        }

        this.localCollection.map(fn);
    }

    public previousInterval(pos: number): TInterval {
        if (!this.attached) {
            throw new Error("attachSequence must be called");
        }

        return this.localCollection.previousInterval(pos);
    }

    public nextInterval(pos: number): TInterval {
        if (!this.attached) {
            throw new Error("attachSequence must be called");
        }

        return this.localCollection.nextInterval(pos);
    }
}
