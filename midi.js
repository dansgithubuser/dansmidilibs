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

function _eventCmp(l, r) {
  if (l.ticks == r.ticks) {
    if (l.type == 'note_off' && r.type == 'note_on' ) return -1;
    if (l.type == 'note_on'  && r.type == 'note_off') return  1;
  }
  return l.ticks - r.ticks;
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

  // method toDeltamsgs
  toDeltamsgs() {
    const deltamsgs = [];
    // split notes
    const events = [];
    for (const event of this.events) {
      if (event.type =='note') events.push(...this._splitNote(event));
      else events.push(event);
    }
    events.sort(_eventCmp);
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

  // method calculateOctave
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

  // method _splitNote
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
        const trackIndex = this._trackIndexFromY(y);
        const noteNumber = this._noteNumberFromY(y);
        const ticks = this._ticksFromX(x);
        const note = {
          type: 'note',
          ticks: this._quantize(ticks),
          duration: this.duration,
          channel: 0,
          number: noteNumber,
          velocityOn: 64,
          velocityOff: 64,
        };
        if (this.tapMode == 'add') {
          this._addEvent(trackIndex, note);
        } else if (this.tapMode == 'select-space') {
          this._selectSpace(trackIndex, ticks, noteNumber);
        } else {
          const eventIndex = this._getNoteIndex(trackIndex, ticks, noteNumber);
          if (eventIndex != undefined) {
            if (['toggle', 'delete'].includes(this.tapMode)) this._deleteEvent(trackIndex, eventIndex);
            else if (this.tapMode == 'select-note') this._selectEvent(trackIndex, eventIndex);
          } else {
            if (this.tapMode == 'toggle') this._addEvent(trackIndex, note);
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
    const body = document.getElementsByTagName('body')[0];
    body.onkeydown = (event) => {
      if (event.srcElement != body) return;
      do {
        // immediate commands
        {
          const cmd = {
              Alt: () => {},
              Backspace: () => this._message = this._message.slice(0, -1),
              Control: () => {},
              Escape: () => {
                if (this._message != '') {
                  this._message = '';
                  return;
                }
                if (this._keyMode != 'normal') {
                  this._keyMode = 'normal';
                  return;
                }
                this.deselect();
              },
              Shift: () => {},
          }[event.key];
          if (cmd) {
            cmd();
            break;
          }
        }
        // single-character commands
        let commands;
        if (!this._message.length) {
          // single-character commands -- normal
          if (this._keyMode == 'normal') {
            commands = {
              ' ': () => this.selectSpace(),
              'j': () => this.move(+1,  0,  0),
              'k': () => this.move(-1,  0,  0),
              'l': () => this.move( 0, +1,  0),
              'h': () => this.move( 0, -1,  0),
              'K': () => this.move( 0,  0, +1),
              'J': () => this.move( 0,  0, -1),
              'i': () => {
                if (!this.selectedSpace()) this.selectSpace();
                this._keyMode = 'insert';
              },
              's': () => this.selectEvent(),
              ...commands,
            };
          }
          // single-character commands -- insert
          if (this._keyMode == 'insert') {
            commands = {
              'z': () => this.addNote(0),
              's': () => this.addNote(1),
              'x': () => this.addNote(2),
              'd': () => this.addNote(3),
              'c': () => this.addNote(4),
              'v': () => this.addNote(5),
              'g': () => this.addNote(6),
              'b': () => this.addNote(7),
              'h': () => this.addNote(8),
              'n': () => this.addNote(9),
              'j': () => this.addNote(10),
              'm': () => this.addNote(11),
              ' ': () => this.move(0, 1, 0),
              '1': () => this.duration = 1 * this.quantizor,
              '2': () => this.duration = 2 * this.quantizor,
              '3': () => this.duration = 3 * this.quantizor,
              '4': () => this.duration = 4 * this.quantizor,
              '5': () => this.duration = 5 * this.quantizor,
              '6': () => this.duration = 6 * this.quantizor,
              '7': () => this.duration = 7 * this.quantizor,
              '8': () => this.duration = 8 * this.quantizor,
              '9': () => this.duration = 9 * this.quantizor,
              ...commands,
            };
          }
          // single-character commands -- execute
          const cmd = commands[event.key];
          if (cmd) {
            const reps = parseInt(this._message) || 1;
            for (let i = 0; i < reps; ++i) cmd();
            if (reps > 1) this._message = '';
            break;
          }
        }
        // complex commands
        if (event.key == 'Enter') {
          // colon commands
          if (this._message.startsWith(':')) {
            const [colon_cmd, ...args] = this._message.split(' ');
            const cmd = {
              bend: (...args) => this.bend(...args),
              'track.add': () => this.addTrack(),
              transpose: (...args) => transpose(...args),
            }[colon_cmd.slice(1)];
            if (cmd) {
              try {
                cmd(...args);
                this._message = '';
              } catch(e) {
                this._message = e.message;
              }
              break;
            }
          }
          // character commands
          {
            const cmd = {
              ':': () => this.goToBar(...this._params()),
              '/': () => { this.quantizor = this.ticksPerQuarter * 4 / this._params()[0] },
            }[this._message[0]];
            if (cmd){
              cmd();
              this._message = '';
            }
          }
          break;
        }
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
    this._setTicksPerQuarter(360);
    this.tapMode = 'add';
    this._tracks = [new Track(), new Track()];
    this._window = {
      ticksI: 0,
      ticksD: this.ticksPerQuarter * 16,
      trackI: 1,
      trackD: 4,
      notesPerStaff: 24,
    };
    this._selectedEvents = [];
    this._selectedSpace = {};
    this._message = '';
    this._keyMode = 'normal';
  }

  // method fromDeltamsgs
  fromDeltamsgs(deltamsgs) {
    this.ticksPerQuarter = null;
    this._tracks = [];
    for (let line of deltamsgs) {
      if (!line.deltamsgs.length) {
        this._tracks.push(new Track);
        continue;
      }
      if (this.ticksPerQuarter == null) {
        this._setTicksPerQuarter(line.ticks_per_quarter);
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

  // method toDeltamsgs
  toDeltamsgs() {
    return this._tracks.map(track => {
      return {
        deltamsgs: track.toDeltamsgs(),
        ticks_per_quarter: this.ticksPerQuarter,
      };
    });
  }

  // method _setTicksPerQuarter
  _setTicksPerQuarter(ticks) {
    this.ticksPerQuarter = ticks;
    this.duration = this.ticksPerQuarter;
    this.quantizor = this.ticksPerQuarter;
  }

  // method _params
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
  // method fromBytes
  fromBytes(bytes) {
    const chunks = this._chunkitize(bytes);
    this._setTicksPerQuarter(_bigEndianToUnsigned(chunks[0].slice(12, 14)));
    this._tracks = [];
    for (const chunk of chunks.slice(1))
      this._tracks.push(new Track(this._getPairs(chunk)));
    this._render();
  }

  // method _chunkitize
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

  // method _getPairs
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

  // method _readDelta
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
  // method toBytes
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

  // method _writeTrack
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

  // method _writeDelta
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
  // method _render
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
    // render space selection
    const selectedSpaceColor = 'rgba(255, 255, 255, 0.2)';
    if (this._selectedSpace.trackIndex != undefined) this._rect(
      0,
      this._trackY(this._selectedSpace.trackIndex),
      {
        w: this._canvas.width,
        h: -this._trackH(),
        color: selectedSpaceColor,
      },
    );
    if (this._selectedSpace.ticks != undefined) this._rect(
      this._eventX(this._selectedSpace.ticks),
      0,
      {
        xf: this._eventX(this._selectedSpace.ticks + this.duration),
        h: this._canvas.height,
        color: selectedSpaceColor,
      },
    );
    if (this._selectedSpace.noteNumber != undefined) this._rect(
      0,
      this._noteY(
        this._selectedSpace.trackIndex,
        this._tracks[this._selectedSpace.trackIndex].octave,
        this._selectedSpace.noteNumber,
      ),
      {
        w: this._canvas.width,
        h: -this._noteH(),
        color: selectedSpaceColor,
      },
    );
    // render message
    this._rect(
      0, this._canvas.height - this._messageH,
      { w: this._canvas.width, h: this._messageH, color: 'rgba(0, 0, 0, 0.5)' },
    );
    let prefix = ' ';
    if (this._keyMode == 'insert') prefix = 'i';
    this._text(prefix + this._message, 0, this._canvas.height - this._messageH + 12);
  }

  // method _renderEvents
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
      const x = this._eventX(event.ticks);
      if (event.type == 'pitch_wheel') {
        this._line(
          x, y,
          x, y - (event.value - 0x2000) / 0x1000 * this._noteH(),
          'rgba(255, 128, 64, 0.5)'
        );
      } else {
        this._text(
          this._textify(event),
          x, y,
          { color: 'rgb(0, 255, 0)' },
        );
      }
    }
  }

  // method _textify
  _textify(event) {
    if (event.type == 'tempo')
      return `q=${Math.round(60e6 / event.usPerQuarter)}`;
    return JSON.stringify(event);
  }

  // method _trackH
  _trackH() {
    return this._canvas.height / this._window.trackD;
  }

  // method _trackY
  _trackY(trackIndex) {
    return (trackIndex - this._window.trackI + 1) * this._trackH();
  }

  // method _noteH
  _noteH() {
    return this._trackH() / this._window.notesPerStaff;
  }

  // method _noteY
  _noteY(trackIndex, octave = 0, number = 0) {
    return this._trackY(trackIndex) - (number - 12 * octave) * this._noteH();
  }

  // method _eventX
  _eventX(ticks) {
    return (ticks - this._window.ticksI) / this._window.ticksD * this._canvas.width;
  }

  // method _renderNote
  _renderNote(ticks, duration, trackIndex, octave, number, color) {
    const x = this._eventX(ticks);
    const y = this._noteY(trackIndex, octave, number);
    this._rect(x, y, { xf: this._eventX(ticks + duration), h: -this._noteH(), color });
    const d = number - 12 * octave;
    if (d < 0 || d >= this._window.notesPerStaff) {
      const yf = this._noteY(trackIndex, 0, 11);
      this._curve(x, y, x, yf, x + 24, (y + yf) / 2, color);
    }
  }

  // method _rect
  _rect(xi, yi, options) {
    const xf = options.xf || xi + options.w;
    const yf = options.yf || yi + options.h;
    this._ctx.fillStyle = options.color;
    this._ctx.fillRect(xi, yi, xf - xi, yf - yi);
    this._ctx.stroke();
  }

  // method _text
  _text(text, xi, yi, options = {}) {
    const h = options.h || '12px';
    const font = options.font || 'Courier New';
    const color = options.color || 'white';
    this._ctx.font = `${h} ${font}`;
    this._ctx.fillStyle = color;
    this._ctx.fillText(text, xi, yi);
  }

  // method _line
  _line(xi, yi, xf, yf, color) {
    this._ctx.strokeStyle = color;
    this._ctx.beginPath();
    this._ctx.moveTo(xi, yi);
    this._ctx.lineTo(xf, yf);
    this._ctx.stroke();
  }

  // method _curve
  _curve(xi, yi, xf, yf, xm, ym, color) {
    this._ctx.strokeStyle = color;
    this._ctx.beginPath();
    this._ctx.moveTo(xi, yi);
    this._ctx.quadraticCurveTo(xm, ym, xf, yf);
    this._ctx.stroke();
  }

  //----- editing -----//
  // method addTrack
  addTrack() {
    this._tracks.push(new Track);
    this._render();
  }

  // method selectEvent
  selectEvent() {
    if (!this.selectedSpace()) return;
    let eventIndexes = [];
    const track = this._tracks[this._selectedSpace.trackIndex];
    for (let i = 0; i < track.events.length; ++i) {
      const event = track.events[i];
      if (event.ticks < this._selectedSpace.ticks) continue;
      if (event.ticks > this._selectedSpace.ticks + this.duration) break;
      eventIndexes.push(i);
    }
    // fully-contained
    let filtered = eventIndexes.filter(i => {
      const event = track.events[i];
      return (
        this._selectedSpace.ticks <= event.ticks
        && event.ticks < this._selectedSpace.ticks + this.duration
      );
    });
    if (filtered.length) eventIndexes = filtered;
    // same note
    filtered = eventIndexes.filter(i => {
      const event = track.events[i];
      return event.type == 'note' && event.number == this._selectedSpace.noteNumber;
    });
    if (filtered.length) eventIndexes = filtered;
    // select
    for (const eventIndex of eventIndexes)
      this._selectEvent(this._selectedSpace.trackIndex, eventIndex);
  }

  // method deselect
  deselect() {
    if (this._selectedEvents.length) {
      for (const i of this._selectedEvents)
        this._tracks[i[0]].events[i[1]].selected = false;
      this._selectedEvents = [];
    } else if (this.selectedSpace()) {
      this._selectedSpace = {};
    }
    this._render();
  }

  // method selectedSpace
  selectedSpace() {
    return (
      this._selectedSpace.trackIndex != undefined
      && this._selectedSpace.ticks != undefined
      && this._selectedSpace.noteNumber != undefined
    );
  }

  // method selectSpace
  selectSpace() {
    const trackIndex = Math.floor(this._window.trackI) + 1;
    this._selectSpace(
      trackIndex,
      this._quantize(this._window.ticksI, { offset: 1 }),
      this._tracks[trackIndex].octave * 12,
    );
  }

  // method transpose
  transpose(amount) {
    if (typeof amount == 'string') amount = parseInt(amount);
    for (const i of this._selectedEvents) {
      let n = this._tracks[i[0]].events[i[1]].number;
      n += amount;
      if (n < 0) n = 0;
      if (n > 127) n = 127;
      this._tracks[i[0]].events[i[1]].number = n;
    }
    this._render();
  }

  // method bend
  bend(start = 0, end = -2, ticksPerEvent = 4) {
    const { trackIndex, ticks } = this._selectedSpace;
    if (trackIndex == undefined || ticks == undefined) throw new Error('no space selected');
    const n = Math.floor(this.duration / ticksPerEvent);
    const events = [];
    const value_i = 0x2000 + start * 0x1000;
    const value_f = 0x2000 + end * 0x1000;
    for (let i = 0; i < n; ++i) {
      const t = i / (n - 1);
      let value = Math.floor((1 - t) * value_i + t * value_f);
      if (value > 0x3fff) value = 0x3fff;
      else if (value < 0) value = 0;
      events.push({
        type: 'pitch_wheel',
        ticks: ticks + i * ticksPerEvent,
        channel: 0,
        value,
      });
    }
    events.push({
      type: 'pitch_wheel',
      ticks: ticks + this.duration,
      channel: 0,
      value: 0x2000,
    });
    this._addEvents(trackIndex, events);
  }

  // method _addEvent
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

  // method _addEvents
  _addEvents(trackIndex, events) {
    if (trackIndex >= this._tracks.length) return;
    const track = this._tracks[trackIndex];
    track.events.push(...events);
    track.events.sort(_eventCmp);
  }

  // method _ticksFromX
  _ticksFromX(x) {
    return Math.floor(x / this._canvas.width * this._window.ticksD + this._window.ticksI);
  }

  // method _quantize
  _quantize(x, options = {}) {
    const method = Math[options.method || 'floor'];
    const offset = options.offset || 0;
    return method(x / this.quantizor + offset) * this.quantizor;
  }

  // method _trackIndexFromY
  _trackIndexFromY(y) {
    return Math.ceil(y / this._trackH() + this._window.trackI - 1);
  }

  // method _noteNumberFromY
  _noteNumberFromY(y) {
    const trackIndex = this._trackIndexFromY(y);
    if (trackIndex >= this._tracks.length) return;
    const track = this._tracks[trackIndex];
    return Math.floor((this._trackY(trackIndex) - y) / this._noteH() + 12 * track.octave);
  }

  // method _getNoteIndex
  _getNoteIndex(trackIndex, ticks, number) {
    if (trackIndex >= this._tracks.length) return;
    const track = this._tracks[trackIndex];
    for (let i = 0; i < track.events.length; ++i)
      if (
        track.events[i].type == 'note'
        && (number == undefined || track.events[i].number == number)
        && noteEndures(track.events[i], ticks)
      ) return i;
  }

  // method _deleteEvent
  _deleteEvent(trackIndex, eventIndex) {
    this._tracks[trackIndex].events.splice(eventIndex, 1);
  }

  // method _selectEvent
  _selectEvent(trackIndex, eventIndex) {
    this._tracks[trackIndex].events[eventIndex].selected = true;
    this._selectedEvents.push([trackIndex, eventIndex]);
  }

  // method _selectSpace
  _selectSpace(trackIndex, ticks, noteNumber) {
    if (
      trackIndex < 0 || trackIndex >= this._tracks.length
      || ticks < 0
      || noteNumber < 0 || noteNumber > 127
    ) {
      this._selectSpace();
    } else {
      this._selectedSpace = {
        trackIndex,
        ticks,
        noteNumber,
      };
    }
  }

  // method addNote
  addNote(number) {
    if (!this.selectedSpace()) return;
    this._addEvent(this._selectedSpace.trackIndex, {
      type: 'note',
      ticks: this._selectedSpace.ticks,
      duration: this.duration,
      channel: 0,
      number: this._selectedSpace.noteNumber % 12 + number,
      velocityOn: 64,
      velocityOff: 64,
    });
    this.move(0, 1, 0);
  }

  //----- navigation -----//
  // method goToBar
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
    if (this._selectedSpace.ticks)
      this._selectedSpace.ticks = this._window.ticksI;
    this._render();
  }

  // method move
  move(dTrack, dTicks, dNoteNumber) {
    if (this._selectedSpace.trackIndex != undefined && dTrack) {
      this._selectedSpace.trackIndex += dTrack;
      this._selectedSpace.trackIndex = Math.min(this._selectedSpace.trackIndex, this._tracks.length - 1);
      this._selectedSpace.trackIndex = Math.max(this._selectedSpace.trackIndex, 0);
      this._selectedSpace.noteNumber %= this._window.notesPerStaff;
      this._selectedSpace.noteNumber += this._tracks[this._selectedSpace.trackIndex].octave * 12;
      if (this._selectedSpace.trackIndex < this._window.trackI)
        this._window.trackI = this._selectedSpace.trackIndex;
      else if (this._selectedSpace.trackIndex >= this._window.trackI + this._window.trackD)
        this._window.trackI = this._selectedSpace.trackIndex - this._window.trackD + 1;
      return;
    }
    if (this._selectedSpace.ticks != undefined && dTicks) {
      this._selectedSpace.ticks += dTicks * this.duration;
      this._selectedSpace.ticks = Math.max(this._selectedSpace.ticks, 0);
      if (this._selectedSpace.ticks < this._window.ticksI)
        this._window.ticksI = this._selectedSpace.ticks;
      else if (this._selectedSpace.ticks >= this._window.ticksI + this._window.ticksD)
        this._window.ticksI = this._selectedSpace.ticks - this._window.ticksD + this.quantizor;
      return;
    }
    if (this._selectedSpace.noteNumber != undefined && dNoteNumber) {
      this._selectedSpace.noteNumber += dNoteNumber;
      this._selectedSpace.noteNumber = Math.min(this._selectedSpace.noteNumber, 127);
      this._selectedSpace.noteNumber = Math.max(this._selectedSpace.noteNumber, 0);
      return;
    }
  }
}
