import { listenToTouches } from './deps/obvious/obvious.js'

function noteEndures(note, ticks) {
  return note.ticks <= ticks && ticks < note.ticks + note.duration;
}

class Track {
  constructor () {
    this.events = [];
    this.octave = 0;
  }

  calculateOctave(ticksI, ticksF) {
    var lowest = 128;
    for (const event of this.events) {
      if (event.type != 'note') continue;
      if (event.ticks + event.duration < ticksI) continue;
      if (event.ticks > ticksF) break;
      lowest = Math.min(event.number, lowest);
    }
    this.octave = Math.floor(lowest / 12);
  }
};

export class Midi {
  constructor(canvas) {
    this._canvas = canvas;
    listenToTouches(canvas, {
      onTap: (id, x, y) => {
        const makeNote = () => {
          return {
            type: 'note',
            ticks: this._ticksFromX(x),
            duration: this.duration,
            channel: 0,
            number: this._noteNumberFromY(y),
            velocityOn: 64,
            velocityOff: 64,
          };
        };
        if (this.tapMode == 'add') {
          this._addEvent(this._trackIndexFromY(y), makeNote());
        } else if (this.tapMode == 'delete' || this.tapMode == 'toggle') {
          const trackIndex = this._trackIndexFromY(y);
          const eventIndex = this._getNoteIndex(trackIndex, this._ticksFromX(x), this._noteNumberFromY(y));
          if (eventIndex != undefined) this._deleteEvent(trackIndex, eventIndex);
          else if (this.tapMode == 'toggle') this._addEvent(trackIndex, makeNote());
        }
        this._render();
      },
      onDrag: (touches, dx, dy, dSize, dTheta) => {
        if (touches.length == 1) {
          this._window.ticksI -= dx * this._window.ticksD / this._canvas.width;
          this._window.trackI -= dy * this._window.trackD / this._canvas.height;
          this._render();
        }
      },
    });
    // constants
    this._trackHeaderSize = 8;
    this._staves = [
      [21, 'rgb( 0, 32,  0)'],
      [17, 'rgb(32, 32, 32)'],
      [14, 'rgb(32, 32, 32)'],
      [11, 'rgb(32, 32, 32)'],
      [ 7, 'rgb(32, 32, 32)'],
      [ 4, 'rgb(32, 32, 32)'],
      [ 0, 'rgb( 0, 64,  0)'],
    ];
    // variables
    this.ticksPerQuarter = 360;
    this.duration = this.ticksPerQuarter;
    this.quantizor = this.ticksPerQuarter;
    this.tapMode = 'add';
    this._tracks = [new Track(), new Track()];
    this._window = {
      ticksI: 0,
      ticksD: this.ticksPerQuarter * 16,
      trackI: 1,
      trackD: 4,
      notesPerStaff: 24,
    };
  }

  //----- from bytes -----//
  fromBytes(bytes) {
    const chunks = this._chunkitize(bytes);
    this.ticksPerQuarter = this._bigEndianToUnsigned(chunks[0].slice(12, 14));
    this._tracks = [];
    for (const chunk of chunks.slice(1)) {
      var ticks = 0;
      const pairs = this._getPairs(chunk);
      const track = new Track;
      for (var i = 0; i < pairs.length; ++i) {
        const pair = pairs[i];
        ticks += pair.delta;
        if (pair.event[0] >> 4 == 0x9 && pair.event[2]) {// Note on
          var duration = 0;
          var velocityOff = 0x40;
          for (var j = i + 1; j < pairs.length; ++j) {
            duration += pairs[j].delta;
            if (pairs[j].event[0] >> 4 == 0x9 && pairs[j].event[2] == 0 || pairs[j].event[0] >> 4 == 0x8)// Note off
              if (pair.event[1] == pairs[j].event[1]) {
                velocityOff = pairs[j].event[2];
                if (pairs[j].event[0] >> 4 == 0x9) velocityOff = 0x40;
                break;
              }
          }
          track.events.push({
            type: 'note',
            ticks,
            duration,
            channel: pair.event[0] & 0xf,
            number: pair.event[1],
            velocityOn: pair.event[2],
            velocityOff,
          });
        } else if (pair.event[0] >> 4 == 0xb) track.events.push({
          type: 'control',
          ticks,
          channel: pair.event[0] & 0xf,
          number: pair.event[1],
          value: pair.event[2],
        });
        else if (pair.event[0] >> 4 == 0xe) track.events.push({
          type: 'pitch_wheel',
          ticks,
          channel: pair.event[0] & 0xf,
          value: pair.event[1] + (pair.event[2] << 7),
        });
        else if (pair.event[0] == 0xff) {
          if (pair.event[1] == 0x51) track.events.push({
            type: 'tempo',
            ticks,
            usPerQuarter: this._bigEndianToUnsigned(pair.event.slice(3, 6)),
          });
          else if (pair.event[1] == 0x58) track.events.push({
            type: 'time_sig',
            ticks,
            top: pair.event[3],
            bottom: 1 << pair.event[4],
          });
          else if (pair.event[1] == 0x59) {
            var sharps = pair.event[3];
            if (sharps & 0x80) sharps = (sharps & 0x7f) - 0x80;
            track.events.push({
              type: 'key_sig',
              ticks,
              sharps,
              minor: pair.event[4],
            });
          }
        }
      }// pairs
      this._tracks.push(track);
    }// chunks
    this._render();
  }

  _bigEndianToUnsigned(bytes) {
    var result = 0;
    for (var i of bytes) {
      result <<= 8;
      result += i;
    }
    return result;
  }

  _chunkitize(bytes) {
    const chunks = [bytes.slice(0, 14)];
    var i = chunks[0].length;
    while (i < bytes.length) {
      const trackSize = this._bigEndianToUnsigned(bytes.slice(i + 4, i + 8));
      const j = i + this._trackHeaderSize + trackSize;
      chunks.push(bytes.slice(i, j));
      i = j;
    }
    return chunks
  }

  _getPairs(trackChunk) {
    const pairs = [];
    var i = this._trackHeaderSize;
    var runningStatus = null;
    while (i < trackChunk.length) {
      var delta, status, parameters = [];
      [delta, i] = this._readDelta(trackChunk, i);
      if (trackChunk[i] & 0x80) {
        status = trackChunk[i];
        if (status >> 4 != 0xf) runningStatus = status;
        ++i;
      }
      else status = runningStatus;
      if ([0x8, 0x9, 0xa, 0xb, 0xe].includes(status >> 4)) {
        parameters = trackChunk.slice(i, i + 2);
        i += 2;
      } else if ([0xc, 0xd].includes(status >> 4)) {
        parameters = trackChunk.slice(i, i+1);
        i += 1;
      } else if (status >> 4 == 0xf) {
        if (status == 0xff) {
          const l = 2 + trackChunk[i + 1];
          parameters = trackChunk.slice(i, i + l);
          i += l;
        }
        else parameters = [];
      }
      pairs.push({ delta, event: [status, ...parameters] });
    }
    return pairs;
  }

  _readDelta(bytes, i) {
    var delta = 0;
    for (var j = 0; j < 4; ++j) {
      delta <<= 7;
      delta += bytes[i] & 0x7f;
      if (!(bytes[i] & 0x80)) break;
      ++i;
    }
    return [delta, i + 1];
  }

  //----- to bytes -----//
  toBytes() {
    const bytes = [77, 84, 104, 100, 0, 0, 0, 6, 0, 1];
    bytes.push(...this._unsignedToBigEndian(this._tracks.length, 2));
    bytes.push(...this._unsignedToBigEndian(this.ticksPerQuarter, 2));
    var trackBytes = [];
    var ticks = 0;
    for (event of this._tracks[0].events) {
      trackBytes.push(...this._writeDelta(event.ticks - ticks));
      if (event.type == 'tempo') {
        trackBytes.push(...[0xff, 0x51, 0x03]);
        trackBytes.push(...this._unsignedToBigEndian(event.usPerQuarter, 3));
      } else if (event.type == 'time_sig') {
        trackBytes.push(...[0xff, 0x58, 0x04]);
        trackBytes.push(...[event.top, this._ilog2(event.bottom), 24, 8]);
      } else if (event.type == 'key_sig') {
        trackBytes.push(...[0xff, 0x59, 0x02]);
        var sharps = event.sharps;
        if (sharps < 0) sharps = 0x100 + sharps;
        trackBytes.push(...[sharps, event.minor ? 1 : 0]);
      } else throw new Error('unhandled event type: ' + event.type);
      ticks = event.ticks;
    }
    this._writeTrack(trackBytes, bytes);
    for (const track of this._tracks.slice(1)) {
      const events = [];
      for (const event of track.events) {
        if (event.type =='note') events.push(...this._splitNote(event));
        else events.push(event);
      }
      events.sort((l, r) => {
        if (l.ticks == r.ticks) {
          if (l.type == 'note_off' && r.type == 'note_on' ) return -1;
          if (l.type == 'note_on'  && r.type == 'note_off') return  1;
        }
        return l.ticks - r.ticks;
      });
      ticks = 0;
      for (const event of events) {
        const t = event.ticks;
        event.ticks -= ticks;
        ticks = t;
      }
      trackBytes = [];
      for (const event of events) {
        if (event.type == 'note_on') {
          trackBytes.push(...this._writeDelta(event.ticks));
          trackBytes.push(0x90 | event.channel);
          trackBytes.push(event.number);
          trackBytes.push(event.velocity);
        } else if (event.type == 'note_off') {
          trackBytes.push(...this._writeDelta(event.ticks));
          trackBytes.push(0x80 | event.channel);
          trackBytes.push(event.number);
          trackBytes.push(event.velocity);
        } else if (event.type == 'control') {
          trackBytes.push(...this._writeDelta(event.ticks));
          trackBytes.push(0xb0 | event.channel);
          trackBytes.push(event.number);
          trackBytes.push(event.value);
        } else if (event.type == 'pitch_wheel') {
          trackBytes.push(...this._writeDelta(event.ticks));
          trackBytes.push(0xe0 | event.channel);
          trackBytes.push(event.value & 0x7f);
          trackBytes.push(event.value >> 7);
        }
      }
      this._writeTrack(trackBytes, bytes);
      return bytes;
    }//tracks
  }

  _writeTrack(trackBytes, bytes) {
    //Some idiot midi players ignore the first delta, so start with an empty text event
    const emptyTextEvent = [0, 0xff, 0x01, 0];
    if (trackBytes.slice(0, 4) != emptyTextEvent) trackBytes.unshift(...emptyTextEvent);
    trackBytes.push(...[1, 0xff, 0x2f, 0]);
    trackBytes.unshift(
      ...[77, 84, 114, 107],
      ...this._unsignedToBigEndian(trackBytes.length, 4),
    );
    bytes.push(...trackBytes);
  }

  _unsignedToBigEndian(u, size) {
    const result = [];
    for (var i = 0; i < size; ++i) {
      result.push((u >> ((size - 1 - i) * 8)) & 0xff);
    }
    return result;
  }

  _writeDelta(ticks) {
    const result = [];
    for (var i = 0; i < 4; ++i) {
      result.unshift(ticks & 0x7f);
      ticks >>= 7;
      if (ticks == 0) {
        for (var j = 0; j < result.length - 1; ++j) result[j] |= 0x80;
        return result;
      }
    }
  }

  _ilog2(x) {
    var result = -1;
    while (x) {
      x >>= 1;
      ++result;
    }
    return result;
  }

  _splitNote(note) {
    return [
      {
        type: 'note_on',
        ticks: note.ticks,
        channel: note.channel,
        number: note.number,
        velocity: note.velocityOn,
      }, {
        type: 'note_off',
        ticks: note.ticks + note.duration,
        channel: note.channel,
        number: note.number,
        velocity: note.velocityOff,
      },
    ];
  }

  //----- rendering -----//
  _render() {
    this._ctx = this._canvas.getContext('2d');
    // background
    this._rect(0, 0, { w: this._canvas.width, h: this._canvas.height, color: 'black' });
    const qi = Math.floor(this._window.ticksI / this.ticksPerQuarter);
    for (var q = qi; q < qi + this._window.ticksD / this.ticksPerQuarter; ++q) {
      if (q % 2) continue;
      const ticks = q * this.ticksPerQuarter;
      this._rect(
        this._eventX(ticks),
        0,
        {
          xf: this._eventX(ticks + this.ticksPerQuarter),
          h: this._canvas.height,
          color: 'rgba(255, 255, 255, 0.05)',
        },
      )
    }
    // regular tracks
    for (var trackIndex = 1; trackIndex < this._tracks.length; ++trackIndex) {
      const track = this._tracks[trackIndex];
      // staff
      for (var i = 0; i < this._window.notesPerStaff; i += 24)
        for (const [number, color] of this._staves)
          this._renderNote(
            this._window.ticksI,
            this._window.ticksD,
            trackIndex,
            0,
            number + i,
            color,
          );
      track.calculateOctave(this._window.ticksI, this._window.ticksI + this._window.ticksD);
      for (var i = 0; i < Math.abs(track.octave - 5); ++i) {
        const s = 3 * this._noteH();
        this._rect((i + 0.5) * s * 1.5, this._noteY(trackIndex, 0, -1), {
          w: s,
          h: -s,
          color: track.octave > 5 ? 'rgb(0, 128, 0)' : 'rgb(128, 0, 0)'
        });
      }
      // events
      for (const note of track.events) {
        if (note.type != 'note') continue;
        this._renderNote(note.ticks, note.duration, trackIndex, track.octave, note.number, 'rgb(0, 128, 128)');
      }
      this._renderEvents(track.events.filter((i) => i.type != 'note'), trackIndex);
    }
    // first track
    this._renderEvents(this._tracks[0].events, 0);
  }

  _renderEvents(events, trackIndex) {
    const yi = trackIndex ? this._noteY(trackIndex) : 24;
    var ticks, y = yi;
    for (const event of events) {
      if (event.ticks != ticks) {
        y = yi;
        ticks = event.ticks;
      }
      else y += 12;
      this._text(
        this._textify(event),
        this._eventX(event.ticks),
        y,
        { color: 'rgb(0, 255, 0)' },
      );
    }
  }

  _textify(event) {
    if (event.type == 'tempo')
      return `q=${Math.round(60e6 / event.usPerQuarter)}`;
    return JSON.stringify(event);
  }

  _trackH() {
    return this._canvas.height / this._window.trackD;
  }

  _trackY(trackIndex) {
    return (trackIndex - this._window.trackI + 1) * this._trackH();
  }

  _noteH() {
    return this._trackH() / this._window.notesPerStaff;
  }

  _noteY(trackIndex, octave = 0, note = 0) {
    return this._trackY(trackIndex) - (note - 12 * octave) * this._noteH();
  }

  _eventX(ticks) {
    return (ticks - this._window.ticksI) / this._window.ticksD * this._canvas.width;
  }

  _renderNote(ticks, duration, trackIndex, octave, note, color) {
    const x = this._eventX(ticks);
    const y = this._noteY(trackIndex, octave, note);
    this._rect(x, y, { xf: this._eventX(ticks + duration), h: -this._noteH(), color });
    const d = note - 12 * octave;
    if (d < -2 || d > this._window.notesPerStaff + 2) {
      const yf = this._noteY(trackIndex, 0, 11);
      this._curve(x, y, x, yf, x + 24, (y + yf) / 2, color);
    }
  }

  _rect(xi, yi, options) {
    const xf = options.xf || xi + options.w;
    const yf = options.yf || yi + options.h;
    this._ctx.fillStyle = options.color;
    this._ctx.fillRect(xi, yi, xf - xi, yf - yi);
    this._ctx.stroke();
  }

  _text(text, xi, yi, options) {
    const font = options.font || 'Courier New';
    const h = options.h || '12px';
    this._ctx.font = `${h} ${font}`;
    this._ctx.fillStyle = options.color;
    this._ctx.fillText(text, xi, yi);
  }

  _line(xi, yi, xf, yf, color) {
    this._ctx.strokeStyle = color;
    this._ctx.beginPath();
    this._ctx.moveTo(xi, yi);
    this._ctx.lineTo(xf, yf);
    this._ctx.stroke();
  }

  _curve(xi, yi, xf, yf, xm, ym, color) {
    this._ctx.strokeStyle = color;
    this._ctx.beginPath();
    this._ctx.moveTo(xi, yi);
    this._ctx.quadraticCurveTo(xm, ym, xf, yf);
    this._ctx.stroke();
  }

  //----- editing -----//
  _addEvent(trackIndex, event) {
    if (trackIndex >= this._tracks.length) return;
    const track = this._tracks[trackIndex];
    for (var i = 0; i < track.events.length; ++i)
      if (track.events[i].ticks > event.ticks) {
        track.events.splice(i, 0, event);
        break;
      }
  }

  _ticksFromX(x) {
    return this._quantize(x / this._canvas.width * this._window.ticksD + this._window.ticksI);
  }

  _quantize(x, options = {}) {
    if (options.method == 'round')
      return Math.round(x / this.quantizor) * this.quantizor
    else
      return Math.floor(x / this.quantizor) * this.quantizor;
  }

  _trackIndexFromY(y) {
    return Math.ceil(y / this._trackH() + this._window.trackI - 1);
  }

  _noteNumberFromY(y) {
    const trackIndex = this._trackIndexFromY(y);
    if (trackIndex >= this._tracks.length) return;
    const track = this._tracks[trackIndex];
    return Math.floor((this._trackY(trackIndex) - y) / this._noteH() + 12 * track.octave);
  }

  _getNoteIndex(trackIndex, ticks, number){
    if (trackIndex >= this._tracks.length) return;
    const track = this._tracks[trackIndex];
    for (var i = 0; i < track.events.length; ++i)
      if (track.events[i].type == 'note' && track.events[i].number == number && noteEndures(track.events[i], ticks))
        return i;
  }

  _deleteEvent(trackIndex, eventIndex) {
    this._tracks[trackIndex].events.splice(eventIndex, 1);
  }
}
