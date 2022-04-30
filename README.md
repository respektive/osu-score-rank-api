# Score Rank API

If you want to add the Score Rank to any of your programs you can use my Score Rank API which works by using [osu!api v2](https://osu.ppy.sh/docs/) to get the top 10k users of the score ranking leaderboard and saving it in a DB updating every 30min-ish.

- <https://score.respektive.pw/rankings> shows the top 50 for osu!std. you can use parameters to go to other pages or check a different mode e.g. `https://score.respektive.pw/rankings?page=2&mode=mania` or `https://score.respektive.pw/rankings?page=13&m=1`
- <https://score.respektive.pw/u/3172980> to look up the rank and score for a user id. mode parameters work here too like `https://score.respektive.pw/u/3172980?m=3`
- <https://score.respektive.pw/rank/727> to check the user for a specific rank. mode parameters work here too like `https://score.respektive.pw/rank/1?m=3`

> I will try to keep this API running until there is a Score Rank Endpoint in the official API. But don't be suprised if this might just go offline at one point (It probably won't but I will make sure to update this readme then tho)
