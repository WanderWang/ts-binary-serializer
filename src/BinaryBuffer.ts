import { Float16 } from "./Float16";
import { TypeMetaClass } from "./TypeMetaClass";
import { DataType } from "./DataType";

type TypeMeta = TypeMetaClass | DataType;

export class BinaryBuffer {
    public m_arrayBuffer: Uint8Array;
    private static readonly DEFAULT_BUFFER_SIZE: number = 512;
    private m_arrayBufferCurrentSize: number = BinaryBuffer.DEFAULT_BUFFER_SIZE;
    private m_view: DataView;
    private m_pos: number = 0;
    private constructor() { }

    private static WriteFuncMap: { [t: number]: string } = {};
    private static ReadFuncMap: { [t: number]: string } = {};

    public static initialize() {
        for (var t in DataType) {
            if (!isNaN(Number(t))) continue;
            let v = DataType[t];
            this.WriteFuncMap[v] = "write" + t;
            this.ReadFuncMap[v] = "read" + t;
        }
    }

    public get pos(): number {
        return this.m_pos;
    }

    public static create(): BinaryBuffer {
        let buffer = new BinaryBuffer();
        let uint8ary = new Uint8Array(BinaryBuffer.DEFAULT_BUFFER_SIZE);
        buffer.m_arrayBuffer = uint8ary;
        buffer.m_view = new DataView(uint8ary.buffer);
        return buffer;
    }


    public checkBufferExpand(appendSize: number = 8) {
        let cursize = this.m_arrayBufferCurrentSize;
        if (this.m_pos + appendSize >= cursize) {
            let tarsize = cursize + appendSize;
            while (cursize < tarsize) {
                cursize = cursize << 1;
            }
            let curbuf = this.m_arrayBuffer;
            let newbuf = new Uint8Array(cursize);
            newbuf.set(curbuf, 0);
            this.m_arrayBuffer = newbuf;
            this.m_arrayBufferCurrentSize = cursize;
            this.m_view = new DataView(newbuf.buffer, 0, cursize);
        }
    }

    public static createWithView(arybuffer: ArrayBuffer, offset: number, bytesize: number): BinaryBuffer {
        let buffer = new BinaryBuffer();
        buffer.m_arrayBuffer = new Uint8Array(arybuffer);
        buffer.m_view = new DataView(arybuffer, offset, bytesize);
        buffer.m_pos = offset;

        return buffer;
    }

    public pushProperty<T extends TypeMetaClass | DataType>(type: DataType, val: any, isary = false, tmc?: T) {
        if (val == null) {
            this.writeType(DataType.Null);
            return;
        }
        this.writeType(type);
        let f: (v: any) => void = this[BinaryBuffer.WriteFuncMap[type]];
        let isobj = type == DataType.Object;
        let ismap = type == DataType.Map;

        if (!isary) {
            this.checkBufferExpand(8);
            if (isobj) {
                Reflect.apply(f, this, [tmc])
            }
            else if (ismap) {
                this.writeMap(val, tmc);
            }
            else {
                Reflect.apply(f, this, [val]);
            }
            return;
        }
        if (!Array.isArray(val)) {
            let msg = `target property: ${val} is not an array.`;
            throw new Error(msg);
        }
        let ary = <Array<any>>val;
        let arylen = ary.length;
        if (arylen > 65535) {
            throw new Error('array length exceeded.');
        }
        this.checkBufferExpand(arylen * 8 + 4);
        this.writeUint16(arylen);
        if (isobj) {
            for (let i = 0; i < arylen; i++) {
                Reflect.apply(f, this, [ary[i], tmc]);
            }
        }
        else if (ismap) {
            for (let i = 0; i < arylen; i++) {
                this.writeMap(ary[i], tmc);
            }
        } else {
            for (let i = 0; i < arylen; i++) {
                f.call(this, ary[i]);
            }
        }
    }

    public readProperty<T extends TypeMeta>(type: DataType, isary = false, tmc?: T): any {
        let t = this.readType();
        if (t == DataType.Null)
            return null;
        if (t != type)
            throw new Error("data type mismatch " + t + " " + type);
        let f: (v: any) => void = this[BinaryBuffer.ReadFuncMap[type]];
        let isobj = type == DataType.Object;
        let ismap = type == DataType.Map;

        if (!isary) {
            if (isobj) {
                if (tmc == null) {
                    throw new Error('tmc is null');
                }
                return f.call(this, tmc);
            }
            else if (ismap) {
                if (tmc == null) throw new Error("read property tmc missing: " + type);
                return this.readMap(tmc);
            } else {
                return f.call(this, null);
            }

        }

        let arylen = this.readUint16();
        if (arylen == 0) return [];

        let ary: any[] = [];
        if (isobj) {
            for (let i = 0; i < arylen; i++) {
                ary.push(f.call(this, tmc));
            }
        }
        else if (ismap) {
            if (tmc == null) throw new Error("read property tmc missing: " + type);
            for (let i = 0; i < arylen; i++) {
                ary.push(this.readMap(tmc));
            }
        }
        else {
            for (let i = 0; i < arylen; i++) {
                ary.push(f.call(this, null));
            }
        }

        return ary;
    }

    public writeMap<T extends TypeMetaClass | DataType>(o: { [key: string]: any }, tmc?: T) {
        if (o == null) {
            this.writeUint16(0);
            return;
        }
        var ownnames = Object.getOwnPropertyNames(o);
        ownnames.sort();
        if (tmc == null) throw new Error("type not found for:" + o);
        let len = ownnames.length;
        if (len > 65535) throw new Error("map size exceed!");
        this.writeUint16(len);
        for (let t = 0, len = ownnames.length; t < len; t++) {
            let key = ownnames[t];
            this.writeString(key);
            let v = o[key];
            if (v == null) {
                this.writeBool(false);
            }
            else {
                this.writeBool(true);

                if (tmc instanceof TypeMetaClass) {
                    this.writeObject(v, tmc);
                }
                else {
                    let f: (v: any) => void = this[BinaryBuffer.WriteFuncMap[<DataType>tmc]];
                    f.call(this, v);
                }
            }
        }
    }

    public readMap<T extends TypeMeta>(tmc: T): { [key: string]: any } | null {
        let len = this.readUint16();
        if (len == 0) return null;
        var ret = {};
        for (let t = 0; t < len; t++) {
            let key = this.readString();
            if (key == null) throw new Error("key is null");
            let notnull = this.readBool();
            if (notnull) {
                if (tmc instanceof TypeMetaClass) {
                    ret[key] = this.readObject(tmc);
                }
                else {
                    let f: (v: any) => void = this[BinaryBuffer.ReadFuncMap[<DataType>tmc]];
                    ret[key] = f.call(this, null);
                }
            }
            else {
                ret[key] = null;
            }
        }
        return ret;
    }

    public writeFloat16(v: number) {
        let view = this.m_view;
        let p = this.m_pos;
        let d = Float16.Float16ToByte(v);
        view.setUint16(p, d);
        this.m_pos += 2;
    }
    public readFloat16(): number {
        let view = this.m_view;
        let d = view.getUint16(this.m_pos);
        let ret = Float16.ByteToFloat16(d);
        this.m_pos += 2;
        return ret;
    }
    public writeFloat32(v: number) {
        let view = this.m_view;
        let p = this.m_pos;
        view.setFloat32(p, v);
        this.m_pos += 4;
    }
    public readFloat32(): number {
        let view = this.m_view;
        let ret = view.getFloat32(this.m_pos);
        this.m_pos += 4;
        return ret;
    }
    public writeFloat64(v: number) {
        let view = this.m_view;
        let p = this.m_pos;
        try {
            view.setFloat64(p, v);
        }
        catch (e) {
            console.log(p, this.m_arrayBufferCurrentSize);
            throw e;
        }
        this.m_pos += 8;
    }
    public readFloat64(): number {
        let view = this.m_view;
        let ret = view.getFloat64(this.m_pos);
        this.m_pos += 8;
        return ret;
    }

    public writeInt8(v: number) {
        let view = this.m_view;
        let p = this.m_pos;
        view.setInt8(p, v);
        this.m_pos++;
    }
    public readInt8(): number {
        let view = this.m_view;
        let ret = view.getInt8(this.m_pos);
        this.m_pos += 1;
        return ret;
    }
    public writeUint8(v: number) {
        let view = this.m_view;
        let p = this.m_pos;
        view.setUint8(p, v);
        this.m_pos++;
    }
    public readUint8(): number {
        let view = this.m_view;
        let ret = view.getUint8(this.m_pos);
        this.m_pos += 1;
        return ret;
    }
    public writeInt16(v: number) {
        let view = this.m_view;
        let p = this.m_pos;
        view.setInt16(p, v);
        this.m_pos += 2;
    }
    public readInt16(): number {
        let view = this.m_view;
        let ret = view.getInt16(this.m_pos);
        this.m_pos += 2;
        return ret;
    }
    public writeUint16(v: number) {
        let view = this.m_view;
        let p = this.m_pos;
        view.setUint16(p, v);
        this.m_pos += 2;
    }
    public readUint16(): number {
        let view = this.m_view;
        let ret = view.getUint16(this.m_pos);
        this.m_pos += 2;
        return ret;
    }
    public writeInt32(v: number) {
        let view = this.m_view;
        let p = this.m_pos;
        view.setInt32(p, v);
        this.m_pos += 4;
    }
    public readInt32(): number {
        let view = this.m_view;
        let ret = view.getInt32(this.m_pos);
        this.m_pos += 4;
        return ret;
    }
    public writeUint32(v: number) {
        let view = this.m_view;
        let p = this.m_pos;
        view.setUint32(p, v);
        this.m_pos += 4;
    }
    public readUint32(): number {
        let view = this.m_view;
        let ret = view.getUint32(this.m_pos);
        this.m_pos += 4;
        return ret;
    }
    public writeBool(b: boolean) {
        let view = this.m_view;
        let p = this.m_pos;
        view.setUint8(p, b
            ? 1
            : 0);
        this.m_pos++;
    }
    public readBool(): boolean {
        let view = this.m_view;
        let ret = view.getUint8(this.m_pos);
        this.m_pos++;
        return ret == 1;
    }

    public writeString(s: string) {
        this.writeUTF8StrFast(s);
    }

    public readString() {
        return this.readUTF8StrFast();
    }

    // hack implement https://stackoverflow.com/questions/17191945/conversion-between-utf-8-arraybuffer-and-string
    public readUTF8StrFast() {
        const len = this.readInt32();
        if (len == -1) return null;
        let ary: number[] = new Array(len);
        let s = this.m_pos;
        const buf = this.m_arrayBuffer;
        for (let t = 0; t < len; t++) {
            ary[t] = buf[s++];
        }
        let ustr = String.fromCharCode(...ary);
        this.m_pos = s;
        return decodeURIComponent(escape(ustr));
    }

    public writeUTF8StrFast(str: string) {
        if (str == null) {
            this.writeInt32(-1);
            return;
        }
        const utf8 = unescape(encodeURIComponent(str));
        const len = utf8.length;
        this.writeInt32(len);
        this.checkBufferExpand(len);
        const view = this.m_view;
        let p = this.m_pos;
        for (let t = 0; t < len; t++) {
            view.setUint8(p++, utf8.charCodeAt(t));
        }
        this.m_pos = p;
    }

    public writeUTF8Str(str: string) {
        if (str == null) {
            this.writeInt32(-1);
            return;
        }
        const len = str.length;
        this.writeInt32(len);
        this.checkBufferExpand(len * 4);
        const view = this.m_view;
        let p = this.m_pos;
        for (var t = 0; t < len; t++) {
            const c = str.charCodeAt(t);
            if (c < 0x80) {
                view.setUint8(p++, c);
            }
            else if (c < 0x800) {
                view.setUint8(p++, (c >> 6) | 0xc0);
                view.setUint8(p++, 0x80 | (c & 0x3f));
            }
            else if (c < 0x10000) {
                view.setUint8(p++, 0xe0 | (c >> 12));
                view.setUint8(p++, 0x80 | ((c >> 6) & 0x3f));
                view.setUint8(p++, 0x80 | (c & 0x3f));
            }
            else {
                view.setUint8(p++, 0xf0 | (c >> 18));
                view.setUint8(p++, 0x80 | ((c >> 12) & 0x3f));
                view.setUint8(p++, 0x80 | ((c >> 6) & 0x3f));
                view.setUint8(p++, 0x80 | (c & 0x3f));
            }
        }
        this.m_pos = p;
    }

    public readUTF8Str() {
        var len = this.readInt32();
        if (len == -1) {
            return null;
        }
        var charary: number[] = new Array(len);
        for (let t = 0; t < len; t++) {
            let c0 = this.readUint8();
            if (c0 >> 7 == 0) {
                charary[t] = c0;
            }
            else if (c0 >> 5 == 0b110) {
                const c1 = this.readUint8();
                charary[t] = ((c0 & 0x1F) << 6) | (c1 & 0x3F);
            }
            else if (c0 >> 4 == 14) {
                const c1 = this.readUint8();
                const c2 = this.readUint8();
                charary[t] = ((c0 & 0x0F) << 12) | ((c1 & 0x3F) << 6) | (c2 & 0x3F);
            }
            else {
                const c1 = this.readUint8();
                const c2 = this.readUint8();
                const c3 = this.readUint8();
                charary[t] = ((c0 & 0x07) << 18) | ((c1 & 0x3F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F);
            }
        }
        return String.fromCharCode(...charary);
    }

    public writeType(t: DataType) {
        this.writeUint8(t);
    }

    public readType(): DataType {
        let ret = this.readUint8();
        return ret;
    }

    public writeObject(o: any, tmc: TypeMetaClass) {
        this.serialize(tmc, o);
    }

    public readObject(tmc: TypeMetaClass) {
        let tar = Object.create(tmc.prototype);
        this.deserialize(tar, tmc);
        return tar;
    }

    public serialize<T>(mc: TypeMetaClass, obj: T) {
        let properties = mc.properties;
        for (let i = 0, len = properties.length; i < len; i++) {
            let p = properties[i];
            this.pushProperty(p.datatype, obj[p.key], p.isArray, p.pclass);
        }
    }

    public deserialize<T>(tar: T, mc: TypeMetaClass): T | null {
        if (mc == null) {
            throw new Error('typeMetaClass is null');
        }
        mc.sortProperty();

        let properties = mc.properties;
        for (let i = 0, len = properties.length; i < len; i++) {
            let p = properties[i];
            var val = this.readProperty(p.datatype, p.isArray, p.pclass);
            tar[p.key] = val;
        }
        return tar;
    }
}
BinaryBuffer.initialize();