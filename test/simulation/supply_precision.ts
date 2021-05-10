/*
  In this script,
  During every iteration:
  * We double the total fragments supply.
  * We test the following guarantee:
      - the difference in totalSupply() before and after the rebase(+1) should be exactly 1.
*/

import { ethers, upgrades } from 'hardhat'
import { expect } from 'chai'

const INITIAL_EXCHANGE_RATE = ethers.BigNumber.from(10).pow(8)
const DECIMALS = 18
const FIRST_MINT_SUPPLY = ethers.utils.parseUnits('50', 6 + DECIMALS)

async function exec() {
  const [deployer] = await ethers.getSigners()
  const factory = await ethers.getContractFactory('UFragments')
  const mockCollateralToken = await (
    await ethers.getContractFactory('MockERC20Token')
  )
    .connect(deployer)
    .deploy()
  const mockMarketOracle = await (await ethers.getContractFactory('MockOracle'))
    .connect(deployer)
    .deploy('MarketOracle')
  await mockMarketOracle.storeData(INITIAL_EXCHANGE_RATE)

  const uFragments = await upgrades.deployProxy(
    factory,
    [await deployer.getAddress(), mockCollateralToken.address, 18],
    {
      initializer: 'initialize(address, address, uint256)',
    },
  )
  await uFragments.connect(deployer).setMarketOracle(mockMarketOracle.address)

  await mockCollateralToken.mint(await deployer.getAddress(), FIRST_MINT_SUPPLY)
  await mockCollateralToken
    .connect(deployer)
    .approve(uFragments.address, FIRST_MINT_SUPPLY)
  await uFragments.mint(await deployer.getAddress(), FIRST_MINT_SUPPLY)

  const endSupply = ethers.BigNumber.from(2).pow(128).sub(1)
  let preRebaseSupply = ethers.BigNumber.from(0),
    postRebaseSupply = ethers.BigNumber.from(0),
    exchangeRate = INITIAL_EXCHANGE_RATE

  let i = 0
  do {
    console.log('Iteration', i + 1)

    preRebaseSupply = await uFragments.totalSupply()
    exchangeRate = exchangeRate.add(exchangeRate.div(100))
    await mockMarketOracle.storeData(exchangeRate)
    await uFragments.connect(deployer).rebase()
    postRebaseSupply = await uFragments.totalSupply()
    console.log('Rebased by 1%')
    console.log('Total supply is now', postRebaseSupply.toString(), 'AMPL')

    console.log('Testing precision of supply')
    expect(postRebaseSupply.sub(preRebaseSupply).mul(100)).to.eq(
      preRebaseSupply,
    )

    console.log('Doubling supply')
    exchangeRate = exchangeRate.mul(2)
    await mockMarketOracle.storeData(exchangeRate)
    await uFragments.connect(deployer).rebase()
    i++
  } while ((await uFragments.totalSupply()).lt(endSupply))
}

describe('Supply Precision', function () {
  it('should successfully run simulation', async function () {
    await exec()
  })
})
