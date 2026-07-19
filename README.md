# Dashboard Trade Republic

Tableau de bord auto-hébergé pour compte titre Trade Republic : performance du
portefeuille en temps réel, positions ouvertes, historique des positions soldées.
L'historique des transactions est lu **en direct** depuis un Google Sheet — rien
n'est stocké côté serveur.

- Graphique de performance (TWR) avec périodes 1 J / 1 S / 1 M / 6 M / 1 A / 3 A / Tout
- Valeur temps réel des positions, espèces, P&L latent et réalisé, dividendes, frais
- Détail par position : PRU, performance, dernière vente, performance propre du titre
- Section Archives : bilan des positions entièrement soldées
- PWA installable sur téléphone, mode clair/sombre, protégé par mot de passe
- Zéro dépendance npm (Node pur), déployable gratuitement sur Vercel

## Prérequis : le Google Sheet

Un Google Sheet contenant l'historique d'activité Trade Republic, avec ces colonnes
(format des outils d'export TR usuels) :

```
datetime, date, account_type, category, type, asset_class, name, symbol,
shares, price, amount, fee, tax, currency, ...
```

Le sheet doit être partagé en **« Tous les utilisateurs disposant du lien »**
(lecture seule). Le lien de partage sert de configuration : personne d'autre ne le
connaît, ne le publiez nulle part.

## Déployer votre instance (gratuit, ~10 min)

1. **Fork** : bouton « Fork » en haut de cette page GitHub (compte GitHub gratuit).
2. **Vercel** : créez un compte gratuit sur [vercel.com](https://vercel.com) (plan
   Hobby), « Add New… → Project », importez votre fork.
3. **Variables d'environnement** (dans l'écran d'import, section Environment
   Variables — ou plus tard dans Settings → Environment Variables) :
   - `SHEET_URL` : le lien de partage de votre Google Sheet
   - `DASHBOARD_PASSWORD` : le mot de passe qui protégera votre dashboard
4. **Deploy**. Votre dashboard est sur `https://<votre-projet>.vercel.app`.
5. Sur téléphone : ouvrez l'URL, connectez-vous, « Ajouter à l'écran d'accueil ».

**Ne déployez jamais sans `DASHBOARD_PASSWORD`** : l'URL serait publique et votre
portefeuille visible par quiconque la trouve.

## Recevoir les mises à jour

Quand le dépôt d'origine évolue, GitHub affiche sur votre fork un bouton
**« Sync fork »** : cliquez-le, Vercel redéploie automatiquement votre instance
avec la nouvelle version. C'est tout.

## Utilisation locale (optionnel)

```
cp .env.example .env    # puis renseigner SHEET_URL dans .env
npm start               # http://localhost:3457
```

Node >= 22 suffit, aucune installation de dépendances. Sans `DASHBOARD_PASSWORD`,
l'accès local est direct (pas de page de connexion). Le premier chargement prend
15-30 s (récupération des cours), ensuite tout est en cache dans `cache/`.

## Méthodologie des calculs

- **Positions / PRU** : méthode du coût moyen pondéré, rejouée sur tout l'historique.
  Les ventes portent des quantités négatives dans l'export ; `amount` est brut et
  `fee`/`tax` sont des colonnes séparées (cash = amount + fee + tax). Les splits,
  dividendes en actions et actions gratuites entrent à coût nul, ce qui ajuste le PRU
  naturellement. Les frais d'ordre ne sont pas inclus dans le PRU.
- **Résidus** : une position dont il reste moins de 0,04 part est considérée soldée
  et passe en Archives.
- **Performance du portefeuille** : Time-Weighted Return quotidien
  (`r = V_jour / (V_veille + flux du jour) − 1`, chaîné depuis le début de la période).
  Les dépôts/retraits et les achats/ventes ne déforment donc pas la courbe. Les
  dividendes en espèces comptent comme un flux sortant des positions.
- **Prix historiques réels** : Yahoo fournit des séries ajustées rétroactivement des
  splits/attributions. Comme le registre contient les quantités réellement détenues,
  les prix réels sont reconstruits en multipliant la série ajustée par les ratios des
  opérations sur titres du relevé (ex. un split 10:1). Garde-fou supplémentaire :
  la série est comparée aux prix des transactions elles-mêmes et rescalée si l'écart
  médian dépasse 4 % avec au moins 3 transactions concordantes (mauvaise classe de
  parts renvoyée par la recherche ISIN, split survenu après la clôture d'une position).
- **Actifs non cotés sur Yahoo** (warrants, certificats) : valorisés par interpolation
  linéaire entre les prix observés dans les transactions, badge « ≈ » dans l'interface.
- **La vue « 1 J »** agrège les barres 5 min de la dernière séance disponible ; si les
  marchés sont fermés, la dernière séance est affichée et datée.

## Limites connues

- Yahoo Finance ne cote pas certains produits dérivés (warrants Société Générale…) :
  ils sont valorisés au dernier prix de transaction connu.
- L'historique de cours remonte à 3 ans maximum.
- Sur Vercel, le cache est éphémère : après une période d'inactivité, le premier
  chargement refait les appels Yahoo (~15-30 s).
- Le Google Sheet doit rester partagé par lien pour être lisible par le serveur.

## Architecture

```
server.mjs        serveur local (Node pur, port 3457)
api/              fonctions serverless Vercel (mêmes routes que le serveur local)
lib/service.mjs   logique métier partagée (dashboard, séries de performance, logos)
lib/ledger.mjs    moteur de positions (rejeu de l'historique)
lib/portfolio.mjs valorisation EUR, TWR, séries intraday
lib/yahoo.mjs     résolution ISIN, cours, taux de change (cache disque)
lib/auth.mjs      mot de passe optionnel (cookie HMAC signé)
public/           frontend vanilla (graphique SVG fait main, PWA)
```
