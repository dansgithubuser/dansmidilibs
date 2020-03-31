_track_header_size = 8

def _big_endian_to_unsigned(big_endian_bytes):
    result = 0
    for byte in big_endian_bytes:
        result <<= 8
        result += byte
    return result

def _to_big_endian(unsigned, size):
    def extract_byte(unsigned, i):
        return unsigned >> i * 8 & 0xff
    return bytes([
        extract_byte(unsigned, size - 1 - i)
        for i in range(size)
    ])

def _chunkitize(file_bytes):
    header_length = 14
    header_title = b'MThd'
    if len(file_bytes) < header_length:
        raise Exception('header too short')
    if file_bytes[0:len(header_title)] != header_title:
        raise(Exception('bad header'))
    chunks = [file_bytes[:header_length]]
    track_title = b'MTrk'
    index = header_length
    while len(file_bytes) >= index + _track_header_size:
        if file_bytes[index:index+len(track_title)] != track_title:
            raise Exception('bad track header')
        track_size = _big_endian_to_unsigned(file_bytes[index+4:index+8])
        if len(file_bytes) < index + _track_header_size + track_size:
            raise Exception('track too long')
        chunks.append(file_bytes[index:index+_track_header_size+track_size])
        index += _track_header_size + track_size
    if index != len(file_bytes): raise Exception('malformed tracks')
    if _big_endian_to_unsigned(file_bytes[10:12]) != len(chunks) - 1:
        raise Exception('bad size')
    return chunks

def _write_track(file, track_bytes):
    if track_bytes[-4:] != [0x01, 0xff, 0x2f, 0x00]:
        track_bytes += [0x01, 0xff, 0x2f, 0x00]
    track_header = b'MTrk' + _to_big_endian(len(track_bytes), 4)
    file.write(track_header + bytes(track_bytes))

class Deltamsg:
    def delta(self):
        return self._delta

    def delta_bytes(self):
        result = []
        delta = self.delta()
        for i in range(4):
            byte = delta & 0x7f
            delta >>= 7
            result = [byte] + result
            if delta == 0:
                for i in range(len(result) - 1): result[i] |= 0x80
                return result
        raise Exception('delta too big')

    def msg(self):
        return list(self._msg)

    def status(self):
        return self._msg[0]

    def type_nibble(self):
        return self.status() & 0xf0

    def channel(self):
        if self.type_nibble() == 0xf0:
            raise Exception("system messages don't have a channel")
        return self.status() & 0x0f

    def meta_type(self):
        if self.status() != 0xff:
            raise Exception('not meta')
        return self._msg[1]

    def type(self):
        if self.status() == 0xff:
            return {
                0x00: 'sequence_number',
                0x01: 'text',
                0x02: 'copyright',
                0x03: 'track_name',
                0x04: 'instrument_name',
                0x05: 'lyric',
                0x06: 'marker',
                0x07: 'cue',
                0x20: 'channel_prefix',
                0x2f: 'end_of_track',
                0x51: 'tempo',
                0x54: 'smpte_offset',
                0x58: 'time_signature',
                0x59: 'key_signature',
                0x7f: 'sequencer_specific',
            }.get(self.meta_type(), 'unknown')
        return {
            0x80: 'note_off',
            0x90: 'note_on',
            0xa0: 'polyphonic_key_pressure',
            0xb0: 'control_change',
            0xc0: 'program_change',
            0xd0: 'channel_pressure',
            0xe0: 'pitch_wheel_change',
            0xf0: 'system',
        }[self.type_nibble()]

    def __repr__(self):
        return '<{}; {}>'.format(
            self.delta(),
            ' '.join([f'{i:02x}' for i in self.msg()]),
        )

    def _list_from_chunk(chunk):
        result = []
        index = _track_header_size
        running_status = None
        while index < len(chunk):
            deltamsg, index, running_status = Deltamsg._from_chunk(
                chunk, index, running_status
            )
            result.append(deltamsg)
        if result[-1].msg() != [0xff, 0x2f, 0x00]:
            raise Exception('invalid last msg')
        return result

    def _from_chunk(chunk, index, running_status):
        # delta
        delta = 0
        for i in range(index, index+4):
            delta <<= 7
            delta += chunk[i] & 0x7f
            if not chunk[i] & 0x80: break
        else: raise Exception('delta too big')
        index = i+1
        # msg - status
        if chunk[index] & 0x80:
            status = chunk[index]
            if chunk[index] & 0xf0 != 0xf0:
                running_status = status
            index += 1
        else:
            if not running_status: raise Exception('no status')
            status = running_status
        # msg - data
        if status & 0xf0 in [0x80, 0x90, 0xa0, 0xb0, 0xe0]:
            data = chunk[index:index+2]
            index += 2
        elif status & 0xf0 in [0xc0, 0xd0]:
            data = chunk[index:index+1]
            index += 1
        elif status & 0xf0 == 0xf0:
            if status == 0xff:
                data_size = 2 + chunk[index+1]
                data = chunk[index:index+data_size]
                index += data_size
            else:
                data = []
        # result
        deltamsg = Deltamsg()
        deltamsg._delta = delta
        deltamsg._msg = bytes([status]) + data
        return deltamsg, index, running_status

class Song:
    def __init__(self, ticks_per_quarter=360):
        self._ticks_per_quarter = ticks_per_quarter
        self._tracks = []

    def save(self, file_path):
        with open(file_path, 'wb') as file:
            header = (
                b'MThd'
                + bytes([0, 0, 0, 6, 0, 1])
                + _to_big_endian(len(self.tracks()), 2)
                + _to_big_endian(self.ticks_per_quarter(), 2)
            )
            file.write(header)
            for track in self.tracks():
                track_bytes = []
                for deltamsg in track:
                    track_bytes.extend(deltamsg.delta_bytes())
                    track_bytes.extend(deltamsg.msg())
                _write_track(file, track_bytes)

    def load(self, file_path):
        with open(file_path, 'rb') as file: chunks = _chunkitize(file.read())
        self._ticks_per_quarter = _big_endian_to_unsigned(chunks[0][12:14])
        if _big_endian_to_unsigned(chunks[0][8:10]) != 1:
            raise Exception('unhandled file type')
        if _big_endian_to_unsigned(chunks[0][10:12]) != len(chunks) - 1:
            raise Exception('wrong number of tracks')
        self._tracks = [
            Deltamsg._list_from_chunk(chunk)
            for chunk in chunks[1:]
        ]
        return self

    def tracks(self):
        return self._tracks

    def ticks_per_quarter(self):
        return self._ticks_per_quarter
