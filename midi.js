import { listenToTouches } from './deps/obvious/obvious.js'

function noteEndures(note, ticks) {
  return note.ticks <= ticks && ticks < note.ticks + note.duration;
}

function _bigEndianToUnsigned(bytes) {
  let result = 0;
  for (let i of bytes) {
    result <<= 8;
    result += i;
  }
  return result;
}

function _unsignedToBigEndian(u, size) {
  const result = [];
  for (let i = 0; i < size; ++i) {
    result.push((u >> ((size - 1 - i) * 8)) & 0xff);
  }
  return result;
}

function _ilog2(x) {
  let result = -1;
  while (x) {
    x >>= 1;
    ++result;
  }
  return result;
}

class Track {
  constructor(pairs) {
    this.events = [];
    this.octave = 0;
    if (!pairs) return;
    let ticks = 0;
    for (let i = 0; i < pairs.length; ++i) {
      const pair = pairs[i];
      ticks += pair.delta;
      if (pair.event[0] >> 4 == 0x9 && pair.event[2]) {// Note on
        let duration = 0;
        let velocityOff = 0x40;
        for (let j = i + 1; j < pairs.length; ++j) {
          duration += pairs[j].delta;
          if (pairs[j].event[0] >> 4 == 0x9 && pairs[j].event[2] == 0 || pairs[j].event[0] >> 4 == 0x8)// Note off
            if (pair.event[1] == pairs[j].event[1]) {
              velocityOff = pairs[j].event[2];
              if (pairs[j].event[0] >> 4 == 0x9) velocityOff = 0x40;
              break;
            }
        }
        this.events.push({
          type: 'note',
          ticks,
          duration,
          channel: pair.event[0] & 0xf,
          number: pair.event[1],
          velocityOn: pair.event[2],
          velocityOff,
        });
      } else if (pair.event[0] >> 4 == 0xb) this.events.push({
        type: 'control',
        ticks,
        channel: pair.event[0] & 0xf,
        number: pair.event[1],
        value: pair.event[2],
      });
      else if (pair.event[0] >> 4 == 0xe) this.events.push({
        type: 'pitch_wheel',
        ticks,
        channel: pair.event[0] & 0xf,
        value: pair.event[1] + (pair.event[2] << 7),
      });
      else if (pair.event[0] == 0xff) {
        if (pair.event[1] == 0x51) this.events.push({
          type: 'tempo',
          ticks,
          usPerQuarter: _bigEndianToUnsigned(pair.event.slice(3, 6)),
        });
        else if (pair.event[1] == 0x58) this.events.push({
          type: 'time_sig',
          ticks,
          top: pair.event[3],
          bottom: 1 << pair.event[4],
        });
        else if (pair.event[1] == 0x59) {
          let sharps = pair.event[3];
          if (sharps & 0x80) sharps = (sharps & 0x7f) - 0x80;
          this.events.push({
            type: 'key_sig',
            ticks,
            sharps,
            minor: pair.event[4],
          });
        }
      }
    }
  }

  toDeltamsgs() {
    const deltamsgs = [];
    // split notes
    const events = [];
    for (const event of this.events) {
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
    // events to deltamsgs
    let ticks = 0;
    for (event of events) {
      let msg;
      if (event.type == 'tempo') {
        msg = [0xff, 0x51, 0x03, ..._unsignedToBigEndian(event.usPerQuarter, 3)];
      } else if (event.type == 'time_sig') {
        msg = [0xff, 0x58, 0x04, event.top, _ilog2(event.bottom), 24, 8];
      } else if (event.type == 'key_sig') {
        let sharps = event.sharps;
        if (sharps < 0) sharps = 0x100 + sharps;
        msg = [0xff, 0x59, 0x02, sharps, event.minor ? 1 : 0];
      } else if (event.type == 'note_on') {
        msg = [0x90 | event.channel, event.number, event.velocity];
      } else if (event.type == 'note_off') {
        msg = [0x80 | event.channel, event.number, event.velocity];
      } else if (event.type == 'control') {
        msg = [0xb0 | event.channel, trackBytes.push(event.number), event.value];
      } else if (event.type == 'pitch_wheel') {
        msg = [0xe0 | event.channel, event.value & 0x7f, event.value >> 7];
      } else {
        throw new Error('unhandled event type: ' + event.type);
      }
      deltamsgs.push({
        delta: event.ticks - ticks,
        msg,
      });
      ticks = event.ticks;
    }
    // return
    return deltamsgs;
  }

  calculateOctave(ticksI, ticksF) {
    let lowest = 128;
    for (const event of this.events) {
      if (event.type != 'note') continue;
      if (event.ticks + event.duration < ticksI) continue;
      if (event.ticks > ticksF) break;
      lowest = Math.min(event.number, lowest);
    }
    if (lowest == 128)
      this.octave = 5;
    else
      this.octave = Math.floor(lowest / 12);
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
}

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
        } else {
          const trackIndex = this._trackIndexFromY(y);
          const eventIndex = this._getNoteIndex(trackIndex, this._ticksFromX(x), this._noteNumberFromY(y));
          if (eventIndex != undefined) {
            if (['toggle', 'delete'].includes(this.tapMode)) this._deleteEvent(trackIndex, eventIndex);
            else if (this.tapMode == 'select') this._selectEvent(trackIndex, eventIndex);
          } else {
            if (this.tapMode == 'toggle') this._addEvent(trackIndex, makeNote());
          }
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
    document.getElementsByTagName('body')[0].onkeydown = (event) => {
      do {
        // immediate commands
        let cmd = {
          Backspace: () => this._message = this._message.slice(0, -1),
          Escape: () => this._message = '',
        }[event.key];
        if (cmd) { cmd(); break; }
        // complex commands
        if (event.key == 'Enter') {
          let cmd = {
            ':': () => this.goToBar(...this._params()),
          }[this._message[0]];
          if (cmd){
            cmd();
            this._message = '';
          }
          break;
        }
        if (event.key != 'Shift')
          this._message += event.key;
      } while (false);
      this._render();
    };
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
    this._messageH = 16;
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
    this._selected = [];
    this._message = '';
  }

  fromDeltamsgs(deltamsgs) {
    this.ticksPerQuarter = null;
    this._tracks = [];
    for (let line of deltamsgs) {
      if (!line.deltamsgs.length) {
        this._tracks.push(new Track);
        continue;
      }
      if (this.ticksPerQuarter == null) {
        this.ticksPerQuarter = line.ticks_per_quarter;
      } else if (this.ticksPerQuarter != line.ticks_per_quarter) {
        console.error("ticks per quarter doesn't match")
        this._tracks.push(new Track);
        continue;
      }
      for (let deltamsg of line.deltamsgs) {
        deltamsg.event = deltamsg.msg;
      }
      this._tracks.push(new Track(line.deltamsgs));
    }
    this._render();
  }

  toDeltamsgs() {
    return this._tracks.map(track => {
      return {
        deltamsgs: track.toDeltamsgs(),
        ticks_per_quarter: this.ticksPerQuarter,
      };
    });
  }

  _params(offset = 1) {
    return this._message.substring(offset).split(' ').map((v, i) => {
      return {
        float: parseFloat(v),
        int: parseInt(v),
        str: v,
        undefined: parseInt(v),
      }[arguments[i]];
    });
  }

  //----- from bytes -----//
  fromBytes(bytes) {
    const chunks = this._chunkitize(bytes);
    this.ticksPerQuarter = _bigEndianToUnsigned(chunks[0].slice(12, 14));
    this._tracks = [];
    for (const chunk of chunks.slice(1))
      this._tracks.push(new Track(this._getPairs(chunk)));
    this._render();
  }

  _chunkitize(bytes) {
    const chunks = [bytes.slice(0, 14)];
    let i = chunks[0].length;
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
    let i = this._trackHeaderSize;
    let runningStatus = null;
    while (i < trackChunk.length) {
      let delta, status, parameters = [];
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
    let delta = 0;
    for (let j = 0; j < 4; ++j) {
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
    bytes.push(..._unsignedToBigEndian(this._tracks.length, 2));
    bytes.push(..._unsignedToBigEndian(this.ticksPerQuarter, 2));
    for (let track of this._tracks) {
      let trackBytes = [];
      for (let deltamsg of track.toDeltamsgs())
        trackBytes.push(
          ...this._writeDelta(deltamsg.delta),
          ...deltamsg.msg,
        );
      this._writeTrack(trackBytes, bytes);
    }
    return bytes;
  }

  _writeTrack(trackBytes, bytes) {
    //Some idiot midi players ignore the first delta, so start with an empty text event
    const emptyTextEvent = [0, 0xff, 0x01, 0];
    if (trackBytes.slice(0, 4) != emptyTextEvent) trackBytes.unshift(...emptyTextEvent);
    trackBytes.push(...[1, 0xff, 0x2f, 0]);
    trackBytes.unshift(
      ...[77, 84, 114, 107],
      ..._unsignedToBigEndian(trackBytes.length, 4),
    );
    bytes.push(...trackBytes);
  }

  _writeDelta(ticks) {
    const result = [];
    for (let i = 0; i < 4; ++i) {
      result.unshift(ticks & 0x7f);
      ticks >>= 7;
      if (ticks == 0) {
        for (let j = 0; j < result.length - 1; ++j) result[j] |= 0x80;
        return result;
      }
    }
  }

  //----- render -----//
  _render() {
    this._ctx = this._canvas.getContext('2d');
    // render background
    this._rect(0, 0, { w: this._canvas.width, h: this._canvas.height, color: 'black' });
    const qi = Math.floor(this._window.ticksI / this.ticksPerQuarter);
    for (let q = qi; q < qi + this._window.ticksD / this.ticksPerQuarter; ++q) {
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
    // render regular tracks
    for (let trackIndex = 1; trackIndex < this._tracks.length; ++trackIndex) {
      const track = this._tracks[trackIndex];
      // render staff
      for (let i = 0; i < this._window.notesPerStaff; i += 24)
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
      for (let i = 0; i < Math.abs(track.octave - 5); ++i) {
        const s = 3 * this._noteH();
        this._rect((i + 0.5) * s * 1.5, this._noteY(trackIndex, 0, -1), {
          w: s,
          h: -s,
          color: track.octave > 5 ? 'rgb(0, 128, 0)' : 'rgb(128, 0, 0)'
        });
      }
      // render events
      for (const note of track.events) {
        if (note.type != 'note') continue;
        this._renderNote(
          note.ticks,
          note.duration,
          trackIndex,
          track.octave,
          note.number,
          note.selected ? 'rgb(255, 255, 255)' : 'rgb(0, 128, 128)',
        );
      }
      this._renderEvents(track.events.filter((i) => i.type != 'note'), trackIndex);
    }
    // render first track
    if (this._tracks.length)
      this._renderEvents(this._tracks[0].events, 0);
    // render message
    this._rect(
      0, this._canvas.height - this._messageH,
      { w: this._canvas.width, h: this._messageH, color: 'rgba(0, 0, 0, 0.5)' },
    );
    this._text(' ' + this._message, 0, this._canvas.height - this._messageH + 12);
  }

  _renderEvents(events, trackIndex) {
    const yi = trackIndex ? this._noteY(trackIndex) : 24;
    let ticks, y = yi;
    for (const event of events) {
      if (event.ticks < this._window.ticksI) continue;
      if (event.ticks > this._window.ticksI + this._window.ticksD) break;
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

  _text(text, xi, yi, options = {}) {
    const h = options.h || '12px';
    const font = options.font || 'Courier New';
    const color = options.color || 'white';
    this._ctx.font = `${h} ${font}`;
    this._ctx.fillStyle = color;
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
  addTrack() {
    this._tracks.push(new Track);
    this._render();
  }

  deselect() {
    for (const i of this._selected)
      this._tracks[i[0]].events[i[1]].selected = false;
    this._selected = [];
    this._render();
  }

  transpose(amount) {
    if (typeof amount == 'string') amount = parseInt(amount);
    for (const i of this._selected) {
      let n = this._tracks[i[0]].events[i[1]].number;
      n += amount;
      if (n < 0) n = 0;
      if (n > 127) n = 127;
      this._tracks[i[0]].events[i[1]].number = n;
    }
    this._render();
  }

  _addEvent(trackIndex, event) {
    if (trackIndex >= this._tracks.length) return;
    const track = this._tracks[trackIndex];
    for (let i = 0; i < track.events.length; ++i)
      if (track.events[i].ticks > event.ticks) {
        track.events.splice(i, 0, event);
        return;
      }
    track.events.push(event);
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
    for (let i = 0; i < track.events.length; ++i)
      if (track.events[i].type == 'note' && track.events[i].number == number && noteEndures(track.events[i], ticks))
        return i;
  }

  _deleteEvent(trackIndex, eventIndex) {
    this._tracks[trackIndex].events.splice(eventIndex, 1);
  }

  _selectEvent(trackIndex, eventIndex) {
    this._tracks[trackIndex].events[eventIndex].selected = true;
    this._selected.push([trackIndex, eventIndex]);
  }

  //----- navigation -----//
  goToBar(bar) {
    let currBar = 0;
    let timeSig = {top: 4, bottom: 4};
    this._window.ticksI = 0;
    for (event of this._tracks[0].events) {
      if (currBar >= bar) break;
      const ticksInBar = this.ticksPerQuarter * 4 * timeSig.top / timeSig.bottom;
      while (event.ticks - this._window.ticksI >= ticksInBar) {
        this._window.ticksI += ticksInBar;
        ++currBar;
        if (currBar >= bar) break;
      }
      if (event.type == 'time_sig') timeSig = event;
    }
    this._render();
  }
}
