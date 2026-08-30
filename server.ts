import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  getDb,
  queryAll,
  queryOne,
  runExec,
  saveDbToDisk,
  cleanupInactivePigeons,
  getNextMemberCode,
  formatMemberCode,
  seedCategoriesForClub,
} from './server/db.ts';
import {
  calculateHaversineDistance,
  calculateVincentyDistance,
  calculateFlightDuration,
  calculateVelocity,
  formatTimeDiff,
} from './server/calculations.ts';
import {
  parseSMSClockingMessage,
  generateSMSAck,
} from './server/smsParser.ts';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Initialize SQLite Database
  const db = await getDb();

  // -------------------------------------------------------------
  // API Routes
  // -------------------------------------------------------------

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // -------------------------------------------------------------
  // CLUBS & CLUB MANAGERS API
  // -------------------------------------------------------------

  // GET /api/clubs - list all clubs with manager and metric summaries
  app.get('/api/clubs', (req, res) => {
    try {
      const clubs = queryAll<any>(db, `
        SELECT c.*,
          m.id as manager_id,
          m.name as manager_name,
          m.email as manager_email,
          m.phone as manager_phone,
          m.role as manager_role,
          m.badge_number as manager_badge,
          m.avatar_color as manager_avatar,
          (SELECT COUNT(*) FROM fanciers f WHERE f.club_id = c.id OR f.club LIKE ('%' || c.short_code || '%') OR f.club LIKE ('%' || c.name || '%')) as member_count,
          (SELECT COUNT(*) FROM races r WHERE r.club_id = c.id) as race_count,
          (SELECT COUNT(*) FROM basket_entries b JOIN fanciers f ON b.fancier_id = f.id WHERE f.club_id = c.id OR f.club LIKE ('%' || c.short_code || '%')) as total_birds_basketed
        FROM clubs c
        LEFT JOIN club_managers m ON m.club_id = c.id
        ORDER BY c.name ASC
      `);

      const formatted = clubs.map((c) => ({
        id: c.id,
        name: c.name,
        short_code: c.short_code,
        established_year: c.established_year,
        headquarters: c.headquarters,
        hq_lat: c.hq_lat,
        hq_lng: c.hq_lng,
        contact_email: c.contact_email,
        contact_phone: c.contact_phone,
        logo_color: c.logo_color,
        motto: c.motto,
        created_at: c.created_at,
        member_count: c.member_count || 0,
        race_count: c.race_count || 0,
        total_birds_basketed: c.total_birds_basketed || 0,
        manager: c.manager_id
          ? {
              id: c.manager_id,
              club_id: c.id,
              club_name: c.name,
              club_short_code: c.short_code,
              name: c.manager_name,
              email: c.manager_email,
              phone: c.manager_phone,
              role: c.manager_role,
              badge_number: c.manager_badge,
              avatar_color: c.manager_avatar,
            }
          : undefined,
      }));

      res.json(formatted);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/clubs/:id - single club details with members and races
  app.get('/api/clubs/:id', (req, res) => {
    try {
      const club = queryOne<any>(db, 'SELECT * FROM clubs WHERE id = ? OR short_code = ?', [req.params.id, req.params.id.toUpperCase()]);
      if (!club) {
        return res.status(404).json({ error: 'Club not found' });
      }

      const manager = queryOne<any>(db, 'SELECT * FROM club_managers WHERE club_id = ?', [club.id]);
      const members = queryAll<any>(db, `
        SELECT f.*, (SELECT COUNT(*) FROM pigeons p WHERE p.fancier_id = f.id) as pigeon_count
        FROM fanciers f
        WHERE f.club_id = ? OR f.club LIKE ('%' || ? || '%') OR f.club LIKE ('%' || ? || '%')
        ORDER BY f.name ASC
      `, [club.id, club.short_code, club.name]);

      const races = queryAll<any>(db, `
        SELECT r.*,
          (SELECT COUNT(*) FROM basket_entries b WHERE b.race_id = r.id) as total_birds,
          (SELECT COUNT(*) FROM arrivals a WHERE a.race_id = r.id) as total_clocked
        FROM races r
        WHERE r.club_id = ?
        ORDER BY r.created_at DESC
      `, [club.id]);

      res.json({
        ...club,
        manager: manager || null,
        members,
        races,
        member_count: members.length,
        race_count: races.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/clubs - create new club and assign manager account
  app.post('/api/clubs', (req, res) => {
    try {
      const {
        name,
        short_code,
        established_year = new Date().getFullYear(),
        headquarters,
        hq_lat,
        hq_lng,
        contact_email,
        contact_phone,
        logo_color = '#f59e0b',
        motto = 'Excellence in Homing & Velocity',
        manager_name,
        manager_email,
        manager_phone,
        manager_role = 'Club President & Race Director',
      } = req.body;

      if (!name || !short_code || !headquarters) {
        return res.status(400).json({ error: 'Missing required club fields (name, short_code, headquarters)' });
      }

      const clubId = `club-${short_code.toLowerCase().replace(/[^a-z0-9]/g, '')}-${Date.now().toString().slice(-4)}`;
      const createdAt = new Date().toISOString();

      runExec(
        db,
        `INSERT INTO clubs (id, name, short_code, established_year, headquarters, hq_lat, hq_lng, contact_email, contact_phone, logo_color, motto, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          clubId,
          name,
          short_code.toUpperCase(),
          Number(established_year),
          headquarters,
          Number(hq_lat || 14.60),
          Number(hq_lng || 121.00),
          contact_email || manager_email || '',
          contact_phone || manager_phone || '',
          logo_color,
          motto,
          createdAt,
        ]
      );

      // Create Manager account if provided
      let managerObj: any = null;
      if (manager_name) {
        const mgrId = `mgr-${short_code.toLowerCase()}-${Date.now().toString().slice(-4)}`;
        const badgeNumber = `MGR-${short_code.toUpperCase()}-${new Date().getFullYear()}`;
        runExec(
          db,
          `INSERT INTO club_managers (id, club_id, name, email, phone, role, badge_number, avatar_color, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            mgrId,
            clubId,
            manager_name,
            manager_email || `${short_code.toLowerCase()}@pigeon.org`,
            manager_phone || '',
            manager_role,
            badgeNumber,
            logo_color,
            createdAt,
          ]
        );
        managerObj = {
          id: mgrId,
          club_id: clubId,
          name: manager_name,
          email: manager_email,
          phone: manager_phone,
          role: manager_role,
          badge_number: badgeNumber,
        };
      }

      // Initialize manager-isolated race entry categories for this new club
      seedCategoriesForClub(db, clubId);

      res.status(201).json({
        id: clubId,
        name,
        short_code: short_code.toUpperCase(),
        manager: managerObj,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/clubs/:id - update club profile
  app.put('/api/clubs/:id', (req, res) => {
    try {
      const { name, short_code, headquarters, hq_lat, hq_lng, contact_email, contact_phone, logo_color, motto } = req.body;
      runExec(
        db,
        `UPDATE clubs SET
           name = COALESCE(?, name),
           short_code = COALESCE(?, short_code),
           headquarters = COALESCE(?, headquarters),
           hq_lat = COALESCE(?, hq_lat),
           hq_lng = COALESCE(?, hq_lng),
           contact_email = COALESCE(?, contact_email),
           contact_phone = COALESCE(?, contact_phone),
           logo_color = COALESCE(?, logo_color),
           motto = COALESCE(?, motto)
         WHERE id = ?`,
        [name, short_code?.toUpperCase(), headquarters, hq_lat ? Number(hq_lat) : null, hq_lng ? Number(hq_lng) : null, contact_email, contact_phone, logo_color, motto, req.params.id]
      );
      res.json({ success: true, id: req.params.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/club-managers - list all managers
  app.get('/api/club-managers', (req, res) => {
    try {
      const managers = queryAll<any>(db, `
        SELECT m.*, c.name as club_name, c.short_code as club_short_code, c.logo_color as club_logo_color
        FROM club_managers m
        JOIN clubs c ON m.club_id = c.id
        ORDER BY m.name ASC
      `);
      res.json(managers);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/club-managers/:id - update manager account details
  app.put('/api/club-managers/:id', (req, res) => {
    try {
      const { name, email, phone, role, badge_number } = req.body;
      runExec(
        db,
        `UPDATE club_managers SET
           name = COALESCE(?, name),
           email = COALESCE(?, email),
           phone = COALESCE(?, phone),
           role = COALESCE(?, role),
           badge_number = COALESCE(?, badge_number)
         WHERE id = ?`,
        [name, email, phone, role, badge_number, req.params.id]
      );
      res.json({ success: true, id: req.params.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/clubs/:id/members - get members for a specific club
  app.get('/api/clubs/:id/members', (req, res) => {
    try {
      const club = queryOne<any>(db, 'SELECT * FROM clubs WHERE id = ?', [req.params.id]);
      const members = queryAll<any>(db, `
        SELECT f.*,
          (SELECT COUNT(*) FROM pigeons p WHERE p.fancier_id = f.id) as pigeon_count
        FROM fanciers f
        WHERE f.club_id = ? OR (f.club_id IS NULL AND f.club LIKE ('%' || ? || '%'))
        ORDER BY f.name ASC
      `, [req.params.id, club ? club.short_code : req.params.id]);
      res.json(members);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/clubs/:id/members - register new member loft directly into this club
  app.post('/api/clubs/:id/members', (req, res) => {
    try {
      const clubId = req.params.id;
      const club = queryOne<any>(db, 'SELECT * FROM clubs WHERE id = ?', [clubId]);
      const { name, loft_name, phone, lat, lng, address } = req.body;

      if (!name || !loft_name || lat == null || lng == null) {
        return res.status(400).json({ error: 'Missing name, loft_name, lat or lng' });
      }

      const id = `f-${Date.now()}`;
      const clubName = club ? `${club.name} (${club.short_code})` : 'Club Member';
      // System exclusively assigns unique sequential member code (000000001 to infinite) regardless of club
      const fancierCode = getNextMemberCode(db);

      runExec(
        db,
        `INSERT INTO fanciers (id, club_id, name, loft_name, phone, lat, lng, address, club, code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, clubId, name, loft_name, phone || '', Number(lat), Number(lng), address || '', clubName, fancierCode, new Date().toISOString()]
      );

      res.status(201).json({
        id,
        club_id: clubId,
        name,
        loft_name,
        phone: phone || '',
        lat: Number(lat),
        lng: Number(lng),
        address: address || '',
        club: clubName,
        code: fancierCode,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/clubs/:id/invite-member - invite/add an existing system loft into this club
  app.post('/api/clubs/:id/invite-member', (req, res) => {
    try {
      const clubId = req.params.id;
      const { fancier_id } = req.body;
      if (!fancier_id) {
        return res.status(400).json({ error: 'Missing fancier_id to invite' });
      }

      const club = queryOne<any>(db, 'SELECT * FROM clubs WHERE id = ?', [clubId]);
      if (!club) {
        return res.status(404).json({ error: 'Club not found' });
      }

      const fancier = queryOne<any>(db, 'SELECT * FROM fanciers WHERE id = ?', [fancier_id]);
      if (!fancier) {
        return res.status(404).json({ error: 'Fancier / Member Loft not found in system' });
      }

      const clubName = `${club.name} (${club.short_code})`;
      runExec(
        db,
        `UPDATE fanciers SET club_id = ?, club = ? WHERE id = ?`,
        [clubId, clubName, fancier_id]
      );

      const updated = queryOne<any>(db, 'SELECT * FROM fanciers WHERE id = ?', [fancier_id]);
      res.json({
        success: true,
        message: `Loft "${fancier.loft_name}" (${fancier.name} - ${fancier.code}) successfully invited and added to ${club.name}!`,
        member: updated,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/clubs/:id/members/:fancierId - remove member from this club (releases to general)
  app.delete('/api/clubs/:id/members/:fancierId', (req, res) => {
    try {
      const { id: clubId, fancierId } = req.params;
      const fancier = queryOne<any>(db, 'SELECT * FROM fanciers WHERE id = ?', [fancierId]);
      if (!fancier) {
        return res.status(404).json({ error: 'Member not found' });
      }

      runExec(
        db,
        `UPDATE fanciers SET club_id = NULL, club = 'General Union' WHERE id = ?`,
        [fancierId]
      );

      res.json({
        success: true,
        message: `Member "${fancier.name}" (${fancier.loft_name}) removed from club roster.`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/races - list all races (with optional club_id filter)
  app.get('/api/races', (req, res) => {
    try {
      const clubFilter = req.query.club_id as string;
      let sql = `
        SELECT r.*,
          (SELECT COUNT(*) FROM basket_entries b WHERE b.race_id = r.id) as total_birds,
          (SELECT COUNT(*) FROM arrivals a WHERE a.race_id = r.id) as total_clocked,
          (SELECT MAX(velocity_mpm) FROM arrivals a WHERE a.race_id = r.id) as winning_velocity
        FROM races r
      `;
      const params: any[] = [];
      if (clubFilter) {
        sql += ` WHERE r.club_id = ? `;
        params.push(clubFilter);
      }
      sql += ` ORDER BY r.created_at DESC `;

      const races = queryAll<any>(db, sql, params);
      res.json(races);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/races/:id - single race details
  app.get('/api/races/:id', (req, res) => {
    try {
      const race = queryOne<any>(db, `
        SELECT r.*,
          (SELECT COUNT(*) FROM basket_entries b WHERE b.race_id = r.id) as total_birds,
          (SELECT COUNT(*) FROM arrivals a WHERE a.race_id = r.id) as total_clocked,
          (SELECT MAX(velocity_mpm) FROM arrivals a WHERE a.race_id = r.id) as winning_velocity
        FROM races r
        WHERE r.id = ?
      `, [req.params.id]);

      if (!race) {
        return res.status(404).json({ error: 'Race not found' });
      }
      res.json(race);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/races - create new race (with club association)
  app.post('/api/races', (req, res) => {
    try {
      const {
        club_id,
        host_club_name,
        code,
        title,
        liberation_name,
        liberation_lat,
        liberation_lng,
        release_time,
        weather,
        wind,
        notes,
      } = req.body;

      if (!code || !title || !liberation_name || liberation_lat == null || liberation_lng == null) {
        return res.status(400).json({ error: 'Missing required race fields' });
      }

      let resolvedClubName = host_club_name;
      if (club_id && !resolvedClubName) {
        const club = queryOne<any>(db, 'SELECT name, short_code FROM clubs WHERE id = ?', [club_id]);
        if (club) {
          resolvedClubName = `${club.name} (${club.short_code})`;
        }
      }

      const id = `race-${Date.now()}`;
      const status = release_time ? 'liberated' : 'scheduled';
      const created_at = new Date().toISOString();

      runExec(
        db,
        `INSERT INTO races (id, club_id, host_club_name, code, title, liberation_name, liberation_lat, liberation_lng, release_time, status, weather, wind, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          club_id || null,
          resolvedClubName || 'Union Championship',
          code.toUpperCase(),
          title,
          liberation_name,
          Number(liberation_lat),
          Number(liberation_lng),
          release_time || null,
          status,
          weather || '',
          wind || '',
          notes || '',
          created_at,
        ]
      );

      res.status(201).json({ id, club_id, host_club_name: resolvedClubName, code, title, status });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/races/:id - edit existing race details
  app.put('/api/races/:id', (req, res) => {
    try {
      const raceId = req.params.id;
      const existing = queryOne<any>(db, 'SELECT * FROM races WHERE id = ?', [raceId]);
      if (!existing) {
        return res.status(404).json({ error: 'Race not found' });
      }

      const {
        code,
        title,
        liberation_name,
        liberation_lat,
        liberation_lng,
        release_time,
        status,
        weather,
        wind,
        notes,
        host_club_name,
        club_id,
      } = req.body;

      const newCode = code !== undefined ? code.toUpperCase().trim() : existing.code;
      const newTitle = title !== undefined ? title.trim() : existing.title;
      const newLibName = liberation_name !== undefined ? liberation_name.trim() : existing.liberation_name;
      const newLibLat = liberation_lat !== undefined ? Number(liberation_lat) : existing.liberation_lat;
      const newLibLng = liberation_lng !== undefined ? Number(liberation_lng) : existing.liberation_lng;
      const newReleaseTime = release_time !== undefined ? (release_time ? release_time : null) : existing.release_time;
      const newStatus = status !== undefined ? status : (newReleaseTime ? 'liberated' : existing.status);
      const newWeather = weather !== undefined ? weather : existing.weather;
      const newWind = wind !== undefined ? wind : existing.wind;
      const newNotes = notes !== undefined ? notes : existing.notes;
      const newHostClub = host_club_name !== undefined ? host_club_name : existing.host_club_name;
      const newClubId = club_id !== undefined ? club_id : existing.club_id;

      runExec(
        db,
        `UPDATE races
         SET code = ?, title = ?, liberation_name = ?, liberation_lat = ?, liberation_lng = ?,
             release_time = ?, status = ?, weather = ?, wind = ?, notes = ?, host_club_name = ?, club_id = ?
         WHERE id = ?`,
        [
          newCode,
          newTitle,
          newLibName,
          newLibLat,
          newLibLng,
          newReleaseTime,
          newStatus,
          newWeather,
          newWind,
          newNotes,
          newHostClub,
          newClubId,
          raceId,
        ]
      );

      const updated = queryOne<any>(db, 'SELECT * FROM races WHERE id = ?', [raceId]);
      res.json({ success: true, race: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/races/:id - delete a race and cascaded records
  app.delete('/api/races/:id', (req, res) => {
    try {
      const raceId = req.params.id;
      const existing = queryOne<any>(db, 'SELECT * FROM races WHERE id = ?', [raceId]);
      if (!existing) {
        return res.status(404).json({ error: 'Race not found' });
      }

      runExec(db, 'DELETE FROM arrivals WHERE race_id = ?', [raceId]);
      runExec(db, 'DELETE FROM basket_entries WHERE race_id = ?', [raceId]);
      runExec(db, 'DELETE FROM races WHERE id = ?', [raceId]);

      res.json({ success: true, message: `Race ${existing.code} (${existing.title}) deleted successfully.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/races/:id/liberate - trigger liberation
  app.post('/api/races/:id/liberate', (req, res) => {
    try {
      const { release_time, weather, wind } = req.body;
      const timeToSet = release_time || new Date().toISOString();

      runExec(
        db,
        `UPDATE races SET release_time = ?, status = 'liberated', weather = COALESCE(?, weather), wind = COALESCE(?, wind) WHERE id = ?`,
        [timeToSet, weather || null, wind || null, req.params.id]
      );

      res.json({ success: true, release_time: timeToSet, status: 'liberated' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/races/:id/results - Leaderboard query with pagination & export support
  app.get('/api/races/:id/results', (req, res) => {
    try {
      const raceId = req.params.id;
      const isExportAll = req.query.all === 'true' || req.query.export === 'true';
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const pageSize = isExportAll ? 1000000 : Math.max(1, parseInt(req.query.pageSize as string) || 50); // Default 50 per page as specified!
      const search = (req.query.search as string || '').trim().toLowerCase();
      const category = (req.query.category as string || '').trim();
      const club = (req.query.club as string || '').trim();
      const sortBy = (req.query.sortBy as string || 'velocity_desc');

      const race = queryOne<any>(db, 'SELECT * FROM races WHERE id = ?', [raceId]);
      if (!race) {
        return res.status(404).json({ error: 'Race not found' });
      }

      // Fetch all arrivals with joined Fancier, Pigeon and Basket details
      let query = `
        SELECT
          a.id,
          a.race_id,
          a.ring_number,
          a.fancier_id,
          f.name as fancier_name,
          f.loft_name,
          f.lat as loft_lat,
          f.lng as loft_lng,
          f.club,
          p.color as pigeon_color,
          p.gender as pigeon_gender,
          p.strain as pigeon_strain,
          b.category,
          a.arrival_time,
          a.clocking_source,
          a.sticker_code,
          a.air_distance_meters,
          a.flight_time_seconds,
          a.velocity_mpm,
          a.diff_seconds,
          a.status,
          a.raw_sms
        FROM arrivals a
        JOIN fanciers f ON a.fancier_id = f.id
        JOIN pigeons p ON a.ring_number = p.ring_number
        LEFT JOIN basket_entries b ON (b.race_id = a.race_id AND b.ring_number = a.ring_number)
        WHERE a.race_id = ?
      `;

      const params: any[] = [raceId];

      if (category && category !== 'ALL') {
        query += ` AND b.category = ?`;
        params.push(category);
      }

      if (club && club !== 'ALL') {
        query += ` AND (f.club = ? OR f.club LIKE ? OR f.club_id = ?)`;
        params.push(club, `%${club}%`, club);
      }

      if (search) {
        query += ` AND (LOWER(a.ring_number) LIKE ? OR LOWER(f.name) LIKE ? OR LOWER(f.loft_name) LIKE ? OR LOWER(p.strain) LIKE ?)`;
        const wildcard = `%${search}%`;
        params.push(wildcard, wildcard, wildcard, wildcard);
      }

      // Order by velocity desc by default
      if (sortBy === 'arrival_time_asc') {
        query += ` ORDER BY a.arrival_time ASC`;
      } else if (sortBy === 'distance_desc') {
        query += ` ORDER BY a.air_distance_meters DESC`;
      } else if (sortBy === 'ring_asc') {
        query += ` ORDER BY a.ring_number ASC`;
      } else {
        query += ` ORDER BY a.velocity_mpm DESC`;
      }

      const allFilteredRows = queryAll<any>(db, query, params);
      const total = allFilteredRows.length;
      const totalPages = Math.ceil(total / pageSize) || 1;

      // Slice for current page
      const offset = (page - 1) * pageSize;
      const pageRows = allFilteredRows.slice(offset, offset + pageSize);

      // Enhance with rank, formatted flight time, velocity in YPM & KM/H, and difference formatting
      const winnerFlightSeconds = allFilteredRows.length > 0 ? allFilteredRows[0].flight_time_seconds : 0;

      const data = pageRows.map((row, index) => {
        const globalRank = offset + index + 1;
        const flightTime = calculateFlightDuration(race.release_time || row.arrival_time, row.arrival_time);
        const { ypm, kmh } = calculateVelocity(row.air_distance_meters, flightTime.minutes);
        const diffSeconds = row.diff_seconds || Math.max(0, row.flight_time_seconds - winnerFlightSeconds);

        return {
          ...row,
          rank: globalRank,
          air_distance_km: Math.round(row.air_distance_meters / 10) / 100,
          flight_time_formatted: flightTime.formatted,
          velocity_ypm: ypm,
          velocity_kmh: kmh,
          diff_formatted: formatTimeDiff(diffSeconds),
        };
      });

      // Also get available categories & clubs for filter dropdowns
      const categories = queryAll<any>(db, 'SELECT DISTINCT category FROM basket_entries WHERE race_id = ? AND category IS NOT NULL', [raceId]).map(c => c.category);
      const clubs = queryAll<any>(db, 'SELECT DISTINCT club FROM fanciers WHERE club IS NOT NULL').map(c => c.club);

      res.json({
        data,
        total,
        page,
        pageSize,
        totalPages,
        race,
        categories,
        clubs,
      });
    } catch (err: any) {
      console.error('Error in /api/races/:id/results:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/clockings - Ingest Clocking from Mobile App or RFID Sensor
  app.post('/api/clockings', (req, res) => {
    try {
      const {
        race_id,
        ring_number,
        sticker_code,
        arrival_time,
        clocking_source = 'MOBILE_APP',
      } = req.body;

      if (!race_id || !sticker_code) {
        return res.status(400).json({ error: 'Missing race_id or sticker_code' });
      }

      const race = queryOne<any>(db, 'SELECT * FROM races WHERE id = ?', [race_id]);
      if (!race) {
        return res.status(404).json({ error: 'Race not found' });
      }
      if (!race.release_time) {
        return res.status(400).json({ error: 'Race has not been liberated yet!' });
      }

      // Find basket entry: either by matching sticker_code directly, or by ring_number & sticker_code
      let basket: any = null;
      if (ring_number) {
        basket = queryOne<any>(
          db,
          'SELECT b.*, f.lat, f.lng, f.name as fancier_name FROM basket_entries b JOIN fanciers f ON b.fancier_id = f.id WHERE b.race_id = ? AND UPPER(b.ring_number) = UPPER(?)',
          [race_id, ring_number]
        );
      }
      if (!basket) {
        basket = queryOne<any>(
          db,
          'SELECT b.*, f.lat, f.lng, f.name as fancier_name FROM basket_entries b JOIN fanciers f ON b.fancier_id = f.id WHERE b.race_id = ? AND UPPER(b.sticker_secret_code) = UPPER(?)',
          [race_id, sticker_code.trim()]
        );
      }

      if (!basket) {
        return res.status(404).json({ error: `No pigeon found registered with Security Sticker Code "${sticker_code}" in this race.` });
      }

      const resolvedRing = basket.ring_number;

      // Check if already clocked
      const existingArrival = queryOne<any>(
        db,
        'SELECT * FROM arrivals WHERE race_id = ? AND UPPER(ring_number) = UPPER(?)',
        [race_id, resolvedRing]
      );
      if (existingArrival) {
        return res.status(409).json({
          error: `Pigeon ${resolvedRing} has already been clocked at ${existingArrival.arrival_time}.`,
          arrival: existingArrival,
        });
      }

      // Verify Sticker Code (Anti-Fraud Check)
      const isValidCode = basket.sticker_secret_code.toUpperCase() === sticker_code.trim().toUpperCase();
      const status = isValidCode ? 'VERIFIED' : 'INVALID_CODE';

      const clockTime = arrival_time || new Date().toISOString();

      // Calculate exact Air-line distance using Haversine Formula
      const distanceMeters = calculateHaversineDistance(
        race.liberation_lat,
        race.liberation_lng,
        basket.lat,
        basket.lng
      );

      // Compute Flight duration and Velocity (mpm)
      const duration = calculateFlightDuration(race.release_time, clockTime);
      const { mpm, ypm, kmh } = calculateVelocity(distanceMeters, duration.minutes);

      const arrivalId = `arr-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      runExec(
        db,
        `INSERT INTO arrivals (id, race_id, ring_number, fancier_id, arrival_time, clocking_source, sticker_code, air_distance_meters, flight_time_seconds, velocity_mpm, diff_seconds, status, raw_sms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          arrivalId,
          race_id,
          resolvedRing.toUpperCase(),
          basket.fancier_id,
          clockTime,
          clocking_source,
          sticker_code.toUpperCase(),
          distanceMeters,
          duration.seconds,
          mpm,
          0,
          status,
          null,
        ]
      );

      // Recalculate diffs
      recalculateArrivalDiffs(db, race_id);

      // Get rank
      const rankRow = queryOne<any>(
        db,
        `SELECT COUNT(*) + 1 as rank FROM arrivals WHERE race_id = ? AND velocity_mpm > ?`,
        [race_id, mpm]
      );

      res.status(201).json({
        success: true,
        arrival_id: arrivalId,
        ring_number: resolvedRing.toUpperCase(),
        fancier: basket.fancier_name,
        air_distance_meters: distanceMeters,
        air_distance_km: (distanceMeters / 1000).toFixed(3),
        flight_duration: duration.formatted,
        velocity_mpm: mpm,
        velocity_ypm: ypm,
        velocity_kmh: kmh,
        rank: rankRow ? rankRow.rank : 1,
        status,
        isValidCode,
      });
    } catch (err: any) {
      console.error('Error in POST /api/clockings:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/sms-gateway/simulate - Ingest Plain-Text Short Message Service
  app.post('/api/sms-gateway/simulate', (req, res) => {
    try {
      const { phone = '+639170000000', raw_message, timestamp } = req.body;

      if (!raw_message) {
        return res.status(400).json({ error: 'Missing raw_message' });
      }

      const parsed = parseSMSClockingMessage(raw_message);
      const smsId = `sms-${Date.now()}`;
      const logTime = timestamp || new Date().toISOString();

      if (!parsed.isValid) {
        const ack = generateSMSAck(false, '', undefined, undefined, parsed.errorMessage);
        runExec(
          db,
          `INSERT INTO sms_logs (id, phone, raw_message, timestamp, char_count, parsed_race_code, parsed_ring_number, parsed_secret_code, status, response_ack)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [smsId, phone, raw_message, logTime, parsed.charCount, null, null, null, 'FAILED', ack]
        );
        return res.status(400).json({ success: false, error: parsed.errorMessage, ack });
      }

      // Find Race by Code
      const race = queryOne<any>(db, 'SELECT * FROM races WHERE UPPER(code) = UPPER(?) OR id = ?', [parsed.raceCode, parsed.raceCode]);
      if (!race) {
        const ack = generateSMSAck(false, parsed.ringNumber || parsed.secretCode || 'UNKNOWN', undefined, undefined, `Race code ${parsed.raceCode} not found.`);
        runExec(
          db,
          `INSERT INTO sms_logs (id, phone, raw_message, timestamp, char_count, parsed_race_code, parsed_ring_number, parsed_secret_code, status, response_ack)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [smsId, phone, raw_message, logTime, parsed.charCount, parsed.raceCode, parsed.ringNumber || null, parsed.secretCode, 'REJECTED', ack]
        );
        return res.status(404).json({ success: false, error: `Race ${parsed.raceCode} not found`, ack });
      }

      if (!race.release_time) {
        const ack = generateSMSAck(false, parsed.ringNumber || parsed.secretCode || 'UNKNOWN', undefined, undefined, `Race ${parsed.raceCode} not liberated yet.`);
        return res.status(400).json({ success: false, error: 'Race has not been liberated yet', ack });
      }

      // Find Basket entry: by ringNumber if provided, otherwise by secretCode
      let basket: any = null;
      if (parsed.ringNumber) {
        basket = queryOne<any>(
          db,
          `SELECT b.*, f.lat, f.lng, f.name as fancier_name FROM basket_entries b
           JOIN fanciers f ON b.fancier_id = f.id
           WHERE b.race_id = ? AND UPPER(b.ring_number) = UPPER(?)`,
          [race.id, parsed.ringNumber]
        );
      }
      if (!basket && parsed.secretCode) {
        basket = queryOne<any>(
          db,
          `SELECT b.*, f.lat, f.lng, f.name as fancier_name FROM basket_entries b
           JOIN fanciers f ON b.fancier_id = f.id
           WHERE b.race_id = ? AND UPPER(b.sticker_secret_code) = UPPER(?)`,
          [race.id, parsed.secretCode]
        );
      }

      if (!basket) {
        const ack = generateSMSAck(false, parsed.ringNumber || parsed.secretCode!, undefined, undefined, `Sticker/Ring not basketed in race.`);
        runExec(
          db,
          `INSERT INTO sms_logs (id, phone, raw_message, timestamp, char_count, parsed_race_code, parsed_ring_number, parsed_secret_code, status, response_ack)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [smsId, phone, raw_message, logTime, parsed.charCount, parsed.raceCode, parsed.ringNumber || null, parsed.secretCode, 'REJECTED', ack]
        );
        return res.status(404).json({ success: false, error: 'Pigeon not basketed in this race', ack });
      }

      const ringToClock = basket.ring_number;

      // Check if already clocked
      const existing = queryOne<any>(
        db,
        'SELECT * FROM arrivals WHERE race_id = ? AND UPPER(ring_number) = UPPER(?)',
        [race.id, ringToClock]
      );
      if (existing) {
        const ack = generateSMSAck(false, ringToClock, undefined, undefined, `Already clocked.`);
        return res.status(409).json({ success: false, error: 'Pigeon already clocked', ack });
      }

      // Validate secret code
      const isCodeValid = basket.sticker_secret_code.toUpperCase() === parsed.secretCode?.toUpperCase();
      const status = isCodeValid ? 'VERIFIED' : 'INVALID_CODE';

      const arrivalTime = logTime;
      const distanceMeters = calculateHaversineDistance(
        race.liberation_lat,
        race.liberation_lng,
        basket.lat,
        basket.lng
      );
      const duration = calculateFlightDuration(race.release_time, arrivalTime);
      const { mpm } = calculateVelocity(distanceMeters, duration.minutes);

      const arrivalId = `arr-${Date.now()}`;
      runExec(
        db,
        `INSERT INTO arrivals (id, race_id, ring_number, fancier_id, arrival_time, clocking_source, sticker_code, air_distance_meters, flight_time_seconds, velocity_mpm, diff_seconds, status, raw_sms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          arrivalId,
          race.id,
          ringToClock.toUpperCase(),
          basket.fancier_id,
          arrivalTime,
          'SMS_GATEWAY',
          parsed.secretCode!.toUpperCase(),
          distanceMeters,
          duration.seconds,
          mpm,
          0,
          status,
          raw_message,
        ]
      );

      recalculateArrivalDiffs(db, race.id);

      const rankRow = queryOne<any>(
        db,
        `SELECT COUNT(*) + 1 as rank FROM arrivals WHERE race_id = ? AND velocity_mpm > ?`,
        [race.id, mpm]
      );
      const rank = rankRow ? rankRow.rank : 1;

      const ack = generateSMSAck(true, ringToClock, rank, mpm);

      runExec(
        db,
        `INSERT INTO sms_logs (id, phone, raw_message, timestamp, char_count, parsed_race_code, parsed_ring_number, parsed_secret_code, status, response_ack)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [smsId, phone, raw_message, logTime, parsed.charCount, parsed.raceCode, ringToClock, parsed.secretCode, 'SUCCESS', ack]
      );

      res.status(201).json({
        success: true,
        ack,
        arrival_id: arrivalId,
        ring_number: ringToClock,
        rank,
        velocity_mpm: mpm,
        air_distance_meters: distanceMeters,
        flight_duration: duration.formatted,
      });
    } catch (err: any) {
      console.error('Error in /api/sms-gateway/simulate:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/sms-gateway/logs
  app.get('/api/sms-gateway/logs', (req, res) => {
    try {
      const logs = queryAll<any>(db, 'SELECT * FROM sms_logs ORDER BY timestamp DESC LIMIT 100');
      res.json(logs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/fanciers/next-code - get next sequential member code (000000001 to infinite)
  app.get('/api/fanciers/next-code', (req, res) => {
    try {
      const nextCode = getNextMemberCode(db);
      res.json({ next_code: nextCode });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/fanciers - list fanciers
  app.get('/api/fanciers', (req, res) => {
    try {
      const fanciers = queryAll<any>(db, `
        SELECT f.*,
          (SELECT COUNT(*) FROM pigeons p WHERE p.fancier_id = f.id) as pigeon_count
        FROM fanciers f
        ORDER BY f.code ASC, f.name ASC
      `);
      res.json(fanciers);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/fanciers - add fancier
  app.post('/api/fanciers', (req, res) => {
    try {
      const { club_id, name, loft_name, phone, lat, lng, address, club } = req.body;
      if (!name || !loft_name || lat == null || lng == null) {
        return res.status(400).json({ error: 'Missing required fancier fields (name, loft_name, lat, lng)' });
      }
      const id = `f-${Date.now()}`;
      // System generates unique sequential member code across all clubs (000000001 to infinite)
      const nextCode = getNextMemberCode(db);
      runExec(
        db,
        `INSERT INTO fanciers (id, club_id, name, loft_name, phone, lat, lng, address, club, code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, club_id || null, name, loft_name, phone || '', Number(lat), Number(lng), address || '', club || 'General Union', nextCode, new Date().toISOString()]
      );
      res.status(201).json({ id, club_id, name, loft_name, code: nextCode });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/pigeons - list pigeons (runs automatic 4-month inactivity cleanup)
  app.get('/api/pigeons', (req, res) => {
    try {
      // Automatically prune inactive birds (> 4 months / 120 days since registration or last race event)
      cleanupInactivePigeons(db, 120);

      const pigeons = queryAll<any>(db, `
        SELECT p.*, f.name as fancier_name, f.loft_name,
          (SELECT MAX(b.basket_time) FROM basket_entries b WHERE b.ring_number = p.ring_number) as latest_basket,
          (SELECT MAX(a.arrival_time) FROM arrivals a WHERE a.ring_number = p.ring_number) as latest_arrival
        FROM pigeons p
        JOIN fanciers f ON p.fancier_id = f.id
        ORDER BY p.ring_number ASC
      `);

      const now = Date.now();
      const enriched = pigeons.map((p) => {
        const timestamps = [
          p.created_at ? new Date(p.created_at).getTime() : 0,
          p.last_activity_date ? new Date(p.last_activity_date).getTime() : 0,
          p.latest_basket ? new Date(p.latest_basket).getTime() : 0,
          p.latest_arrival ? new Date(p.latest_arrival).getTime() : 0,
        ].filter((t) => !isNaN(t) && t > 0);

        const latestActiveMs = timestamps.length > 0 ? Math.max(...timestamps) : (p.created_at ? new Date(p.created_at).getTime() : now);
        const daysInactive = Math.max(0, Math.floor((now - latestActiveMs) / (1000 * 60 * 60 * 24)));

        return {
          ...p,
          created_at: p.created_at || new Date().toISOString(),
          last_activity_date: new Date(latestActiveMs).toISOString(),
          days_inactive: daysInactive,
          is_active: daysInactive < 120,
        };
      });

      res.json(enriched);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/pigeons - add pigeon
  app.post('/api/pigeons', (req, res) => {
    try {
      const { ring_number, fancier_id, name, color, gender, strain, birth_year } = req.body;
      if (!ring_number || !fancier_id) {
        return res.status(400).json({ error: 'Missing ring_number or fancier_id' });
      }
      const nowIso = new Date().toISOString();
      runExec(
        db,
        `INSERT INTO pigeons (ring_number, fancier_id, name, color, gender, strain, birth_year, created_at, last_activity_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ring_number.toUpperCase(),
          fancier_id,
          name || 'n/a',
          color || 'n/a',
          gender || 'n/a',
          strain || 'n/a',
          birth_year || new Date().getFullYear(),
          nowIso,
          nowIso,
        ]
      );
      res.status(201).json({ ring_number: ring_number.toUpperCase(), fancier_id, created_at: nowIso });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/pigeons/:ring_number - Edit pigeon details and proper ring band number
  app.put('/api/pigeons/:ring_number', (req, res) => {
    try {
      const originalRing = decodeURIComponent(req.params.ring_number).trim().toUpperCase();
      const existing = queryOne<any>(db, 'SELECT * FROM pigeons WHERE UPPER(ring_number) = ?', [originalRing]);
      if (!existing) {
        return res.status(404).json({ error: `Pigeon with ring band ${originalRing} not found.` });
      }

      const { new_ring_number, ring_number, fancier_id, name, color, gender, strain, birth_year } = req.body;
      const targetRing = (new_ring_number || ring_number || originalRing).trim().toUpperCase();

      if (!targetRing) {
        return res.status(400).json({ error: 'Ring band number cannot be empty.' });
      }

      // If ring number is changing, verify no collision with other birds
      if (targetRing !== originalRing) {
        const duplicate = queryOne<any>(
          db,
          'SELECT * FROM pigeons WHERE UPPER(ring_number) = ? AND UPPER(ring_number) != ?',
          [targetRing, originalRing]
        );
        if (duplicate) {
          return res.status(409).json({
            error: `Cannot rename to "${targetRing}". A pigeon with ring band number "${targetRing}" is already registered in the system.`,
          });
        }
      }

      const newFancierId = fancier_id !== undefined ? fancier_id : existing.fancier_id;
      const newName = name !== undefined ? name : existing.name;
      const newColor = color !== undefined ? color : existing.color;
      const newGender = gender !== undefined ? gender : existing.gender;
      const newStrain = strain !== undefined ? strain : existing.strain;
      const newBirthYear = birth_year !== undefined ? Number(birth_year) : existing.birth_year;

      if (targetRing !== originalRing) {
        // Cascade ring band change to arrivals and basket_entries
        runExec(db, 'UPDATE arrivals SET ring_number = ? WHERE UPPER(ring_number) = ?', [targetRing, originalRing]);
        runExec(db, 'UPDATE basket_entries SET ring_number = ? WHERE UPPER(ring_number) = ?', [targetRing, originalRing]);
        runExec(
          db,
          `UPDATE pigeons 
           SET ring_number = ?, fancier_id = ?, name = ?, color = ?, gender = ?, strain = ?, birth_year = ? 
           WHERE UPPER(ring_number) = ?`,
          [targetRing, newFancierId, newName, newColor, newGender, newStrain, newBirthYear, originalRing]
        );
      } else {
        runExec(
          db,
          `UPDATE pigeons 
           SET fancier_id = ?, name = ?, color = ?, gender = ?, strain = ?, birth_year = ? 
           WHERE UPPER(ring_number) = ?`,
          [newFancierId, newName, newColor, newGender, newStrain, newBirthYear, originalRing]
        );
      }

      const updated = queryOne<any>(
        db,
        `SELECT p.*, f.name as fancier_name, f.loft_name 
         FROM pigeons p 
         JOIN fanciers f ON p.fancier_id = f.id 
         WHERE UPPER(p.ring_number) = ?`,
        [targetRing]
      );

      res.json({
        success: true,
        message: targetRing !== originalRing
          ? `Ring band updated from ${originalRing} to ${targetRing} successfully across all records.`
          : `Pigeon ${targetRing} details updated successfully.`,
        pigeon: updated,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/pigeons/:ring_number - Delete registered bird (Club Manager Only)
  app.delete('/api/pigeons/:ring_number', (req, res) => {
    try {
      const ringNumber = decodeURIComponent(req.params.ring_number).toUpperCase();
      const existing = queryOne<any>(db, 'SELECT * FROM pigeons WHERE UPPER(ring_number) = ?', [ringNumber]);
      if (!existing) {
        return res.status(404).json({ error: `Pigeon with ring band ${ringNumber} not found.` });
      }

      runExec(db, 'DELETE FROM arrivals WHERE UPPER(ring_number) = ?', [ringNumber]);
      runExec(db, 'DELETE FROM basket_entries WHERE UPPER(ring_number) = ?', [ringNumber]);
      runExec(db, 'DELETE FROM pigeons WHERE UPPER(ring_number) = ?', [ringNumber]);

      res.json({
        success: true,
        message: `Registered bird ${ringNumber} successfully deleted by Club Manager.`,
        deleted_ring: ringNumber,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/pigeons/cleanup-inactive - Trigger on-demand cleanup of inactive birds (>4 months)
  app.post('/api/pigeons/cleanup-inactive', (req, res) => {
    try {
      const thresholdDays = Number(req.body.threshold_days) || 120;
      const result = cleanupInactivePigeons(db, thresholdDays);
      res.json({
        success: true,
        threshold_days: thresholdDays,
        deleted_count: result.deletedCount,
        deleted_rings: result.deletedRings,
        message: result.deletedCount > 0
          ? `Successfully purged ${result.deletedCount} inactive birds (> ${thresholdDays} days / 4 months without activity).`
          : `No inactive birds found exceeding the ${thresholdDays}-day (4 months) activity threshold. All registered birds are active.`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/pigeons/simulate-inactive - Test helper to simulate an inactive bird (>4 months)
  app.post('/api/pigeons/simulate-inactive', (req, res) => {
    try {
      const { fancier_id } = req.body;
      const targetFancier = fancier_id || 'f-1';
      const testRing = `INACT-4MO-${Date.now().toString().slice(-4)}`;
      // 130 days ago (more than 4 months / 120 days)
      const inactiveTimestamp = new Date(Date.now() - 130 * 24 * 60 * 60 * 1000).toISOString();

      runExec(
        db,
        `INSERT INTO pigeons (ring_number, fancier_id, name, color, gender, strain, birth_year, created_at, last_activity_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [testRing, targetFancier, 'Test Inactive Bird', 'Grizzle', 'Cock', 'Janssen', 2024, inactiveTimestamp, inactiveTimestamp]
      );

      res.json({
        success: true,
        ring_number: testRing,
        registered_at: inactiveTimestamp,
        inactivity_days: 130,
        message: `Simulated bird ${testRing} registered 130 days ago (>4 months). Fetching or running auto-clean will automatically delete this bird.`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/races/:id/basketed - list basketed birds for race
  app.get('/api/races/:id/basketed', (req, res) => {
    try {
      const basketed = queryAll<any>(
        db,
        `SELECT b.*, f.name as fancier_name, f.loft_name, f.lat as loft_lat, f.lng as loft_lng, f.phone,
                p.color as pigeon_color, p.strain as pigeon_strain, p.gender as pigeon_gender,
                (SELECT a.arrival_time FROM arrivals a WHERE a.race_id = b.race_id AND a.ring_number = b.ring_number) as arrival_time,
                (SELECT a.velocity_mpm FROM arrivals a WHERE a.race_id = b.race_id AND a.ring_number = b.ring_number) as velocity_mpm
         FROM basket_entries b
         JOIN fanciers f ON b.fancier_id = f.id
         JOIN pigeons p ON b.ring_number = p.ring_number
         WHERE b.race_id = ?
         ORDER BY b.basket_time ASC`,
        [req.params.id]
      );
      res.json(basketed);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/categories - get race entry categories strictly for a specific club manager
  app.get('/api/categories', (req, res) => {
    try {
      let targetClubId = req.query.club_id as string;
      const raceId = req.query.race_id as string;

      // If race_id is provided and no club_id, look up the club hosting that race
      if (!targetClubId && raceId) {
        const race = queryOne<any>(db, 'SELECT club_id FROM races WHERE id = ?', [raceId]);
        if (race && race.club_id) {
          targetClubId = race.club_id;
        }
      }

      // If still no club_id specified, default to first available club to maintain isolation
      if (!targetClubId) {
        const firstClub = queryOne<any>(db, 'SELECT id FROM clubs ORDER BY established_year ASC LIMIT 1');
        targetClubId = firstClub ? firstClub.id : 'club-cpu';
      }

      // Ensure this specific club has its own isolated categories seeded
      seedCategoriesForClub(db, targetClubId);

      const query = `
        SELECT c.*,
          (SELECT COUNT(*) 
           FROM basket_entries b 
           JOIN races r ON b.race_id = r.id 
           WHERE b.category = c.name AND (r.club_id = c.club_id OR r.club_id = ?)
          ) as entry_count
        FROM race_categories c
        WHERE c.club_id = ?
        ORDER BY c.rowid ASC
      `;

      const categories = queryAll<any>(db, query, [targetClubId, targetClubId]);
      res.json(categories);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/categories - create a new race entry category for a specific club manager
  app.post('/api/categories', (req, res) => {
    try {
      const { name, code, description, badge_color, club_id } = req.body;
      if (!name || !code) {
        return res.status(400).json({ error: 'Missing required category name or code.' });
      }
      if (!club_id) {
        return res.status(400).json({ error: 'Missing required club_id. Categories are club-manager specific.' });
      }

      // Verify club exists
      const club = queryOne<any>(db, 'SELECT * FROM clubs WHERE id = ?', [club_id]);
      if (!club) {
        return res.status(404).json({ error: 'Specified club not found.' });
      }

      const id = `cat-${club_id}-${Date.now()}`;
      const cleanName = name.trim();
      const cleanCode = code.trim().toUpperCase();

      runExec(
        db,
        `INSERT INTO race_categories (id, club_id, name, code, description, badge_color, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, club_id, cleanName, cleanCode, description || '', badge_color || 'amber', new Date().toISOString()]
      );

      const created = queryOne<any>(db, 'SELECT * FROM race_categories WHERE id = ?', [id]);
      res.status(201).json(created);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/categories/:id - edit club-manager race entry category
  app.put('/api/categories/:id', (req, res) => {
    try {
      const catId = req.params.id;
      const existing = queryOne<any>(db, 'SELECT * FROM race_categories WHERE id = ?', [catId]);
      if (!existing) {
        return res.status(404).json({ error: 'Race category not found' });
      }

      const { name, code, description, badge_color, club_id } = req.body;
      const newName = name !== undefined ? name.trim() : existing.name;
      const newCode = code !== undefined ? code.trim().toUpperCase() : existing.code;
      const newDesc = description !== undefined ? description : existing.description;
      const newColor = badge_color !== undefined ? badge_color : existing.badge_color;
      const newClubId = club_id !== undefined ? club_id : existing.club_id;

      runExec(
        db,
        `UPDATE race_categories
         SET name = ?, code = ?, description = ?, badge_color = ?, club_id = ?
         WHERE id = ?`,
        [newName, newCode, newDesc, newColor, newClubId, catId]
      );

      // If category name changed, update corresponding basket entries for races under this club
      if (existing.name !== newName) {
        runExec(
          db,
          `UPDATE basket_entries 
           SET category = ? 
           WHERE category = ? AND race_id IN (SELECT id FROM races WHERE club_id = ?)`,
          [newName, existing.name, existing.club_id]
        );
      }

      const updated = queryOne<any>(db, 'SELECT * FROM race_categories WHERE id = ?', [catId]);
      res.json({ success: true, category: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/categories/:id - delete club-manager race entry category
  app.delete('/api/categories/:id', (req, res) => {
    try {
      const catId = req.params.id;
      const existing = queryOne<any>(db, 'SELECT * FROM race_categories WHERE id = ?', [catId]);
      if (!existing) {
        return res.status(404).json({ error: 'Race category not found' });
      }

      runExec(db, 'DELETE FROM race_categories WHERE id = ?', [catId]);
      res.json({ success: true, message: `Category "${existing.name}" deleted successfully from club records.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/basket - basket pigeon for race (auto-registers new ring bands to fancier)
  app.post('/api/basket', (req, res) => {
    try {
      const {
        race_id,
        ring_number,
        category = 'Young Bird',
        fancier_id,
        name = 'n/a',
        color = 'n/a',
        gender = 'n/a',
        strain = 'n/a',
        birth_year = new Date().getFullYear(),
      } = req.body;

      if (!race_id || !ring_number) {
        return res.status(400).json({ error: 'Missing race_id or ring_number' });
      }

      const cleanRing = ring_number.trim().toUpperCase();
      let pigeon = queryOne<any>(db, 'SELECT * FROM pigeons WHERE UPPER(ring_number) = ?', [cleanRing]);
      let wasNewPigeon = false;

      if (!pigeon) {
        // If pigeon does not exist, save it under the specified fancier
        let targetFancierId = fancier_id;
        if (!targetFancierId) {
          const firstFancier = queryOne<any>(db, 'SELECT id FROM fanciers LIMIT 1');
          if (firstFancier) {
            targetFancierId = firstFancier.id;
          } else {
            return res.status(400).json({ error: 'No fancier available to associate with this new pigeon.' });
          }
        }

        runExec(
          db,
          `INSERT INTO pigeons (ring_number, fancier_id, name, color, gender, strain, birth_year)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [cleanRing, targetFancierId, name || 'Race Pigeon', color || 'Blue Bar', gender || 'Cock', strain || 'Janssen', Number(birth_year) || new Date().getFullYear()]
        );

        pigeon = queryOne<any>(db, 'SELECT * FROM pigeons WHERE UPPER(ring_number) = ?', [cleanRing]);
        wasNewPigeon = true;
      } else if (fancier_id && pigeon.fancier_id !== fancier_id) {
        // Update fancier assignment if specified
        runExec(db, 'UPDATE pigeons SET fancier_id = ? WHERE UPPER(ring_number) = ?', [fancier_id, cleanRing]);
        pigeon.fancier_id = fancier_id;
      }

      // Check if already basketed
      const existing = queryOne<any>(db, 'SELECT * FROM basket_entries WHERE race_id = ? AND UPPER(ring_number) = ?', [race_id, cleanRing]);
      if (existing) {
        return res.status(409).json({ error: `Pigeon ${cleanRing} is already basketed for this race.` });
      }

      const id = `b-${Date.now()}`;
      const sticker_secret_code = `SEC-${Math.floor(1000 + Math.random() * 9000)}`;
      const basket_time = new Date().toISOString();

      runExec(
        db,
        `INSERT INTO basket_entries (id, race_id, ring_number, fancier_id, category, sticker_secret_code, basket_time)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, race_id, cleanRing, pigeon.fancier_id, category, sticker_secret_code, basket_time]
      );

      res.status(201).json({
        id,
        race_id,
        ring_number: cleanRing,
        fancier_id: pigeon.fancier_id,
        sticker_secret_code,
        category,
        basket_time,
        new_pigeon_created: wasNewPigeon,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/calculate - calculation verification sandbox
  app.post('/api/calculate', (req, res) => {
    try {
      const {
        liberation_lat,
        liberation_lng,
        loft_lat,
        loft_lng,
        release_time,
        arrival_time,
      } = req.body;

      const haversineMeters = calculateHaversineDistance(
        Number(liberation_lat),
        Number(liberation_lng),
        Number(loft_lat),
        Number(loft_lng)
      );

      const vincentyMeters = calculateVincentyDistance(
        Number(liberation_lat),
        Number(liberation_lng),
        Number(loft_lat),
        Number(loft_lng)
      );

      const flight = calculateFlightDuration(release_time, arrival_time);
      const velocity = calculateVelocity(haversineMeters, flight.minutes);

      res.json({
        haversineMeters,
        vincentyMeters,
        airDistanceKm: haversineMeters / 1000,
        flightSeconds: flight.seconds,
        flightMinutes: flight.minutes,
        flightFormatted: flight.formatted,
        velocityMpm: velocity.mpm,
        velocityYpm: velocity.ypm,
        velocityKmh: velocity.kmh,
        formula: 'Velocity (mpm) = Air Distance (meters) / Flight Time (minutes)',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Helper to recalculate time diffs
  function recalculateArrivalDiffs(database: any, raceId: string) {
    const arrivals = queryAll<any>(
      database,
      'SELECT id, flight_time_seconds, velocity_mpm FROM arrivals WHERE race_id = ? ORDER BY velocity_mpm DESC',
      [raceId]
    );
    if (arrivals.length === 0) return;
    const winnerFlightSeconds = arrivals[0].flight_time_seconds;

    for (const arr of arrivals) {
      const diff = Math.max(0, arr.flight_time_seconds - winnerFlightSeconds);
      runExec(database, 'UPDATE arrivals SET diff_seconds = ? WHERE id = ?', [diff, arr.id]);
    }
  }

  // -------------------------------------------------------------
  // Vite Integration
  // -------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`RACE Clocking System Server running on http://localhost:${PORT}`);
  });
}

startServer();
